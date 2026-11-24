/*** Tennis Pro — серверная часть (Google Apps Script). Чистая модель v2.
 *
 * Главная идея модели:
 *   Ресурса всего ДВА — это корты. Бронь ЗАНИМАЕТ корт.
 *   "Услуга" (аренда / тренировка) и "тренер" — это просто ПОЛЯ брони,
 *   а не отдельные сущности. Поэтому никакого linkedTargets больше нет:
 *   проверка занятости = "есть ли на этом корте пересечение по времени".
 *
 * Как развернуть:
 *   1. Google Таблица → Расширения → Apps Script → вставь этот код, сохрани.
 *   2. Project Settings → Script Properties → добавь свойство TOKEN (токен бота от @BotFather).
 *      Токен НЕ хранится в коде и в репозитории. ADMIN_CHAT_IDS / COACH_IDS — ниже.
 *   3. Развернуть → Новое развёртывание → Веб-приложение
 *      (От моего имени, доступ: Все). Скопируй URL вида .../exec.
 *   4. Вставь этот URL в index.html (SCRIPT_URL) и ниже в setWebhook (DEPLOY_URL).
 *   5. Запусти один раз вручную: setWebhook(), setupReminderTrigger(), setupCleanupTrigger().
 *
 * ВАЖНО: после любой правки кода — Развернуть → Управление развёртываниями →
 * редактировать активное развёртывание → Версия: Новая версия → Развернуть.
 * Иначе правки не долетят до реального /exec URL (уже наступали на эти грабли).
 ***************************************************************************/

/* ════════════════ НАСТРОЙКИ (правишь только этот блок) ════════════════ */

// Токен бота читается из Script Properties (не из кода), см. «Как развернуть», шаг 2.
const TOKEN      = PropertiesService.getScriptProperties().getProperty("TOKEN") || "";
const WEBAPP_URL = "https://brave-katrin.github.io/tennis_bot/";
const SHEET_NAME = "Брони";
const TZ         = "Europe/Belgrade";

const OPEN_HOUR  = 8;   // первый слот дня (включительно)
const CLOSE_HOUR = 21;  // последний слот дня (начало брони)

const REMINDER_HOURS    = 3;    // за сколько часов до игры слать напоминание
const CANCEL_CUTOFF_HRS = 12;   // студент может отменить НЕ ПОЗЖЕ чем за N часов
const MAX_DURATION = { court: 2, coach: 2 }; // максимум часов на одну бронь
// Аренда корта: разрешены только эти три варианта длительности (в часах).
const COURT_DURATIONS = [1, 1.5, 2];

// Жёсткая связка КОРТ → ТРЕНЕР. Если однажды поменяются — правится здесь.
const COURT_COACH = {
  "Корт 6": "Галина",
  "Корт 7": "Наталья"
};
const COURTS = Object.keys(COURT_COACH);

// Чаты для уведомлений (твой Telegram ID уже стоит, добавь остальных).
const ADMIN_CHAT_IDS = [132787250];

// Telegram ID тренеров. Только они видят экран «Расписание» и управляют записями.
// 132787250 — админ (временно, пока идёт настройка); убери, когда всё настроишь.
const COACH_IDS = [132787250, 695830190, 510630674]; // админ(временно), Галина, Наталья

// На сколько минут «придерживаются» предложенные варианты переноса,
// чтобы их не перехватили со стороны, пока студент выбирает.
const HOLD_MINUTES = 30;

// БЕЗОПАСНОСТЬ: сервер проверяет подпись Telegram (initData) у запросов.
// DEV_MODE = true ОТКЛЮЧАЕТ проверку — только для локальной отладки в браузере!
// В боевом режиме всегда держи false, иначе дыра открыта.
const DEV_MODE = false;
// Максимальный возраст подписи (сек). Старее — считаем недействительной.
const MAX_AUTH_AGE_SEC = 86400; // 24 часа

// Личные чаты тренеров — уведомления по корту уходят персонально нужному тренеру.
const COACH_CHAT = {
  "Галина":  695830190,
  "Наталья": 510630674
};

/* ════════════════ СТРУКТУРА ТАБЛИЦЫ ════════════════ */

const COLUMNS = [
  "id", "court", "date", "time", "duration", "service", "coach", "status",
  "options", "lockUntil",
  "clientId", "clientName", "phone", "username", "notes", "createdAt"
];

// Возможные статусы брони:
//   confirmed — активная подтверждённая бронь
//   proposed  — тренер предложил ВАРИАНТЫ переноса, ждём выбора студента.
//               options  = JSON-массив [{date,time}] предложенных слотов;
//               lockUntil = момент, до которого эти слоты заблокированы.
//               Старый слот при этом тоже держится — бронь не пропадает.
//   blocked   — слот закрыт тренером (отпуск / корт занят), не клиентская бронь
//   cancelled — отменена (мягкое удаление, для истории)
const STATUS = { CONFIRMED: "confirmed", PROPOSED: "proposed", OFFERED: "offered", BLOCKED: "blocked", CANCELLED: "cancelled" };

/* ════════════════ ТОЧКИ ВХОДА ════════════════ */

// GET — отдаём все НЕотменённые брони (для отрисовки занятости и "мои записи")
// Публичный GET — ТОЛЬКО занятость, без личных данных (имена/телефоны/заметки).
// Достаточно для расчёта свободных слотов у клиента.
function doGet(e) {
  const slim = getBookings()
    .filter(b => b.status !== STATUS.CANCELLED)
    .map(b => ({
      id: b.id, court: b.court, date: b.date, time: b.time, duration: b.duration,
      service: b.service, coach: b.coach, status: b.status, options: b.options, lockUntil: b.lockUntil
    }));
  return jsonOut(slim);
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // 1) Апдейт от Telegram (кнопки в сообщениях / команды).
    // ЭТА ВЕТКА БОЛЬШЕ НЕ ЗАДЕЙСТВОВАНА В ОБЫЧНОЙ РАБОТЕ: апдейты Telegram теперь
    // забираются через polling (см. pollUpdates() ниже в файле), а не через вебхук —
    // потому что Apps Script .../exec всегда отвечает 302, а вебхук Telegram это не
    // переживает и заваливает повторами (см. комментарий у pollUpdates()). Ветка
    // оставлена как есть на случай, если вебхук когда-нибудь снова понадобится.
    if (data.update_id !== undefined || data.message || data.callback_query) {
      try {
        handleTelegram(data);
      } catch (err) {
        Logger.log("handleTelegram error: " + err);
      }
      return ContentService.createTextOutput("OK");
    }

    // 2) Действия из мини-аппа.
    // Проверяем подпись Telegram и привязываем ПОДТВЕРЖДЁННУЮ личность.
    const auth = verifyInitData(data.initData);
    const isCoachReq = DEV_MODE || (auth.ok && coachIdsHas(auth.id));
    if (auth.ok) {
      // Нельзя выдать себя за другого: id берём из подписи, а не из присланного поля.
      data.clientId = String(auth.id);
      if (!data.clientName && auth.name) data.clientName = auth.name;
      if (auth.username) data.username = auth.username;
    }

    // Действия, которые создают записи или шлют уведомления, — только с валидной подписью
    // Telegram. Иначе любой, кто знает URL скрипта, мог бы создавать брони и спамить тренеров.
    const SIGNED_ONLY = ["book", "stringing"];
    if (!DEV_MODE && !auth.ok && SIGNED_ONLY.indexOf(data.action) !== -1) {
      return jsonOut({ ok: false, error: "forbidden" });
    }

    switch (data.action) {
      case "book":
        return jsonOut(createBooking(data));

      case "cancel":
        if (data.byCoach) {
          if (!isCoachReq) return jsonOut({ ok: false, error: "forbidden" });
          return jsonOut(cancelBooking(data.id, true));
        }
        // Студент отменяет — должен быть владельцем брони (проверяем по подписи).
        if (!DEV_MODE) {
          if (!auth.ok) return jsonOut({ ok: false, error: "forbidden" });
          const own = findById(data.id);
          if (own && String(own.clientId) !== String(auth.id)) return jsonOut({ ok: false, error: "forbidden" });
        }
        return jsonOut(cancelBooking(data.id, false));

      case "block":
        if (!isCoachReq) return jsonOut({ ok: false, error: "forbidden" });
        return jsonOut(blockSlot(data));

      case "propose":
        if (!isCoachReq) return jsonOut({ ok: false, error: "forbidden" });
        return jsonOut(proposeReschedule(data));

      case "offer":
        if (!isCoachReq) return jsonOut({ ok: false, error: "forbidden" });
        return jsonOut(makeOffer(data));

      case "clients":
        if (!isCoachReq) return jsonOut({ ok: false, error: "forbidden" });
        return jsonOut({ ok: true, clients: getClientsList() });

      case "schedule":
        // Полные данные (имена/телефоны) — только тренеру.
        if (!isCoachReq) return jsonOut({ ok: false, error: "forbidden" });
        return jsonOut({ ok: true, bookings: getBookings().filter(b => b.status !== STATUS.CANCELLED) });

      case "myBookings": {
        // Свои брони с деталями — по подтверждённой подписи.
        const uid = auth.ok ? String(auth.id) : (DEV_MODE ? String(data.clientId || "") : "");
        if (!uid) return jsonOut({ ok: false, error: "forbidden" });
        const mine = getBookings().filter(b => b.status !== STATUS.CANCELLED && String(b.clientId) === uid);
        return jsonOut({ ok: true, bookings: mine });
      }

      case "myPhone": {
        // Отдаём сохранённый ранее телефон клиента (из листа "Клиенты"), чтобы
        // не спрашивать номер повторно при каждом входе в мини-апп.
        const uid = auth.ok ? String(auth.id) : (DEV_MODE ? String(data.clientId || "") : "");
        return jsonOut({ ok: true, phone: uid ? getClientPhone(uid) : "" });
      }

      case "resolveProposal":
        // Студент отвечает на предложение — должен быть владельцем брони.
        if (!DEV_MODE) {
          if (!auth.ok) return jsonOut({ ok: false, error: "forbidden" });
          const pb = findById(data.id);
          if (pb && String(pb.clientId) !== String(auth.id)) return jsonOut({ ok: false, error: "forbidden" });
        }
        return jsonOut(resolveProposal(data.id, (data.choice === undefined ? null : data.choice)));

      case "stringing":
        return jsonOut(notifyStringing(data));

      default:
        return jsonOut({ ok: false, error: "unknown_action" });
    }
  } catch (err) {
    Logger.log("doPost error: " + err);
    return jsonOut({ ok: false, error: String(err) });
  }
}

/* ════════════════ БЕЗОПАСНОСТЬ: ПОДПИСЬ TELEGRAM ════════════════ */

function coachIdsHas(id) {
  return COACH_IDS.map(String).indexOf(String(id)) !== -1;
}

// Проверяет подпись Telegram WebApp (initData) токеном бота.
// Возвращает { ok, id, name, username }. ok=true только при верной подписи.
function verifyInitData(initData) {
  if (!initData) return { ok: false };
  try {
    const params = {};
    String(initData).split("&").forEach(function (pair) {
      const i = pair.indexOf("=");
      if (i === -1) return;
      params[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    });
    const hash = params.hash;
    if (!hash) return { ok: false };

    // data_check_string: все поля кроме hash, отсортированы, "ключ=значение" через \n
    const dcs = Object.keys(params)
      .filter(function (k) { return k !== "hash"; })
      .sort()
      .map(function (k) { return k + "=" + params[k]; })
      .join("\n");

    // secret_key = HMAC_SHA256(key="WebAppData", message=токен бота)
    const secret = Utilities.computeHmacSha256Signature(TOKEN, "WebAppData");
    // hash = HMAC_SHA256(key=secret_key, message=data_check_string)
    const sig = Utilities.computeHmacSha256Signature(Utilities.newBlob(dcs).getBytes(), secret);
    const hex = sig.map(function (b) { return ("0" + (b & 0xFF).toString(16)).slice(-2); }).join("");
    if (hex !== hash) return { ok: false };

    // Свежесть подписи
    if (params.auth_date) {
      const age = Date.now() / 1000 - Number(params.auth_date);
      if (age > MAX_AUTH_AGE_SEC) return { ok: false, error: "expired" };
    }

    let user = {};
    try { user = JSON.parse(params.user || "{}"); } catch (e) {}
    return {
      ok: true,
      id: user.id,
      name: [user.first_name, user.last_name].filter(Boolean).join(" "),
      username: user.username || ""
    };
  } catch (e) {
    return { ok: false };
  }
}

/* ════════════════ ДОСТУП К ТАБЛИЦЕ ════════════════ */

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS);
  }
  // Дата/время и id храним как ТЕКСТ — чтобы Google не пересчитывал их в числа.
  const colLetter = n => String.fromCharCode(64 + n); // 1->A
  ["id", "date", "time", "options", "lockUntil"].forEach(name => {
    const i = COLUMNS.indexOf(name) + 1;
    if (i > 0) sheet.getRange(colLetter(i) + ":" + colLetter(i)).setNumberFormat("@");
  });
  return sheet;
}

// Читаем все строки в массив объектов. Всё — строки, ничего не пересчитываем.
function getBookings() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const idx = {};
  values[0].forEach((h, i) => idx[String(h).trim()] = i);

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row[idx.id]) continue;
    out.push({
      _row:         r + 1, // номер строки в таблице (для адресных правок)
      id:           String(row[idx.id]).trim(),
      court:        String(row[idx.court]).trim(),
      date:         asText(row[idx.date]),
      time:         asTime(row[idx.time]),
      duration:     Number(row[idx.duration]) || 1,
      service:      String(row[idx.service] || "").trim(),
      coach:        String(row[idx.coach] || "").trim(),
      status:       String(row[idx.status] || STATUS.CONFIRMED).trim(),
      options:      parseOptions(row[idx.options]),
      lockUntil:    String(row[idx.lockUntil] || "").trim(),
      clientId:     String(row[idx.clientId] || "").trim(),
      clientName:   String(row[idx.clientName] || ""),
      phone:        String(row[idx.phone] || ""),
      username:     String(row[idx.username] || ""),
      notes:        String(row[idx.notes] || "")
    });
  }
  return out;
}

function findById(id) {
  return getBookings().find(b => b.id === id) || null;
}

// Адресно меняем поля в одной строке по её номеру.
function patchRow(rowNumber, patch) {
  const sheet = getSheet();
  Object.keys(patch).forEach(key => {
    const col = COLUMNS.indexOf(key) + 1;
    if (col > 0) sheet.getRange(rowNumber, col).setValue(patch[key]);
  });
}

/* ════════════════ ЯДРО: ЗАНЯТОСТЬ И КОНФЛИКТЫ ════════════════ */

// Какие получасовые слоты "HH:MM" занимает бронь, начиная с time, на duration часов.
// Шаг 30 минут — чтобы корректно поддерживать длительность 1.5 часа (аренда корта).
function slotsOf(timeStr, duration) {
  const out = [];
  const start = toMinutes(timeStr);
  const totalMin = Math.round((duration || 1) * 60);
  for (let m = 0; m < totalMin; m += 30) out.push(fromMinutes(start + m));
  return out;
}

// Ключи занятых ячеек для брони: "date|HH:MM".
// У статуса proposed держатся И старый слот, И все предложенные варианты —
// но варианты только пока активна блокировка (lockUntil не истёк).
function occupiedKeys(b) {
  if (b.status === STATUS.CANCELLED) return [];
  const keys = [];
  // У offered нет своего слота (брони ещё нет) — держим только варианты.
  if (b.status !== STATUS.OFFERED && b.date && b.time) {
    slotsOf(b.time, b.duration).forEach(t => keys.push(b.date + "|" + t));
  }
  if ((b.status === STATUS.PROPOSED || b.status === STATUS.OFFERED) && holdActive(b)) {
    (b.options || []).forEach(o => {
      slotsOf(o.time, b.duration).forEach(t => keys.push(o.date + "|" + t));
    });
  }
  return keys;
}

// Активна ли ещё блокировка предложенных вариантов?
function holdActive(b) {
  if (!b.lockUntil) return false;
  return new Date(b.lockUntil).getTime() > Date.now();
}

// Есть ли конфликт на ЭТОМ корте? Никакого linkedTargets — только сам корт.
function hasConflict(bookings, court, date, time, duration, excludeId) {
  const want = {};
  slotsOf(time, duration).forEach(t => want[date + "|" + t] = true);
  return bookings.some(b => {
    if (b.id === excludeId) return false;
    if (b.court !== court) return false;
    if (b.status === STATUS.CANCELLED) return false;
    return occupiedKeys(b).some(k => want[k]);
  });
}

/* ════════════════ СОЗДАНИЕ / ОТМЕНА / БЛОКИРОВКА ════════════════ */

// ВАЖНО про блокировку: LockService.getScriptLock() — ОБЩИЙ лок на весь скрипт,
// им же пользуются blockSlot/proposeReschedule/resolveProposal/makeOffer/resolveOffer.
// Раньше отправка Telegram-уведомлений (tgSend — это сетевой HTTP-запрos) происходила
// ВНУТРИ этого лока. Под нагрузкой (несколько действий почти одновременно) это может
// растянуть выполнение doPost() дольше, чем Telegram готов ждать ответ вебхука —
// а Telegram в таком случае считает доставку неуспешной и ПОВТОРЯЕТ отправку ТОГО ЖЕ
// апдейта снова и снова (может продолжаться часами). Поэтому теперь: лок держим ТОЛЬКО
// на время работы с таблицей, а notify-вызовы делаем уже ПОСЛЕ releaseLock().
function createBooking(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let result, bForNotify = null;
  try {
    const court    = String(data.court || "").trim();
    const date     = String(data.date || "").trim();
    const time     = padTime(String(data.time || "").trim());
    const service  = data.service === "coach" ? "coach" : "court"; // court | coach
    const duration = clampDuration(service, Number(data.duration) || 1);

    if (!COURTS.includes(court)) {
      result = { ok: false, error: "bad_court" };
    } else if (!date || !time) {
      result = { ok: false, error: "bad_datetime" };
    } else if (hoursUntil(date, time) <= 0) {
      // Клиент уже прячет прошедшие слоты в интерфейсе, но это дополнительная
      // защита на сервере — на случай прямого вызова API или гонки времени
      // (например, слот был свободен секунду назад, а сейчас уже прошёл).
      result = { ok: false, error: "past" };
    } else {
      const bookings = getBookings();
      if (hasConflict(bookings, court, date, time, duration, null)) {
        result = { ok: false, error: "occupied" };
      } else {
        const coach = service === "coach" ? (COURT_COACH[court] || "") : "";
        const id = newId();
        getSheet().appendRow(rowFor({
          id, court, date, time, duration, service, coach, status: STATUS.CONFIRMED,
          options: "", lockUntil: "",
          clientId: data.clientId ? String(data.clientId) : "",
          clientName: data.clientName || "", phone: data.phone || "",
          username: data.username || "", notes: data.notes || ""
        }));
        bForNotify = { id, court, coach, service, date, time, duration,
          clientId: data.clientId ? String(data.clientId) : "",
          clientName: data.clientName, username: data.username, phone: data.phone, notes: data.notes };
        result = { ok: true, id };
      }
    }
  } finally {
    lock.releaseLock();
  }
  if (bForNotify) {
    notifyCoachNewBooking(bForNotify);
    notifyStudentNewBooking(bForNotify);
  }
  return result;
}

// Отмена. byCoach=true снимает ограничение 12 часов. Иначе — проверяем на сервере.
function cancelBooking(id, byCoach) {
  const b = findById(id);
  if (!b || b.status === STATUS.CANCELLED) return { ok: false, error: "not_found" };

  if (!byCoach && hoursUntil(b.date, b.time) < CANCEL_CUTOFF_HRS) {
    return { ok: false, error: "too_late", cutoff: CANCEL_CUTOFF_HRS };
  }

  patchRow(b._row, { status: STATUS.CANCELLED });
  notifyCancellation(b, byCoach);
  return { ok: true };
}

// Тренер закрывает слот (отпуск / корт занят и т.п.).
function blockSlot(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const court = String(data.court || "").trim();
    const date  = String(data.date || "").trim();
    const time  = padTime(String(data.time || "").trim());
    if (!COURTS.includes(court) || !date || !time) return { ok: false, error: "bad_input" };

    const bookings = getBookings();
    if (hasConflict(bookings, court, date, time, 1, null)) return { ok: false, error: "occupied" };

    const id = newId();
    getSheet().appendRow(rowFor({
      id, court, date, time, duration: 1, service: "block",
      coach: COURT_COACH[court] || "", status: STATUS.BLOCKED,
      options: "", lockUntil: "",
      clientId: "", clientName: data.reason || "Закрыто", phone: "", username: "", notes: ""
    }));
    return { ok: true, id };
  } finally {
    lock.releaseLock();
  }
}

/* ════════════════ ПЕРЕНОС: ТРЕНЕР ПРЕДЛАГАЕТ → СТУДЕНТ РЕШАЕТ ════════════════ */

// Тренер предлагает студенту НЕСКОЛЬКО вариантов времени. Старая бронь остаётся,
// а все предложенные слоты придерживаются на HOLD_MINUTES минут (статус proposed).
// data.options = [{date,time}, ...] (1..5 вариантов на том же корте).
function proposeReschedule(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let result, notifyArgs = null;
  try {
    const b = findById(data.id);
    if (!b || b.status === STATUS.CANCELLED) {
      result = { ok: false, error: "not_found" };
    } else {
      let opts = (data.options || [])
        .map(o => ({ date: String(o.date || "").trim(), time: padTime(String(o.time || "").trim()) }))
        .filter(o => o.date && o.time);
      if (opts.length === 0) {
        result = { ok: false, error: "no_options" };
      } else {
        if (opts.length > 5) opts = opts.slice(0, 5);

        // Каждый предложенный слот должен быть свободен (саму бронь исключаем).
        const bookings = getBookings();
        const conflict = opts.find(o => hasConflict(bookings, b.court, o.date, o.time, b.duration, b.id));
        if (conflict) {
          result = { ok: false, error: "occupied", slot: conflict };
        } else {
          const lockUntil = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
          patchRow(b._row, { status: STATUS.PROPOSED, options: JSON.stringify(opts), lockUntil: lockUntil });
          notifyArgs = { b: b, opts: opts };
          result = { ok: true, count: opts.length, lockUntil: lockUntil };
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
  if (notifyArgs) notifyStudentProposal(notifyArgs.b, notifyArgs.opts);
  return result;
}

// Студент решает. chosen = индекс выбранного варианта (число), либо null = «оставить своё».
function resolveProposal(id, chosen) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let result, notifyArgs = null;
  try {
    const b = findById(id);
    if (!b || b.status !== STATUS.PROPOSED) {
      result = { ok: false, error: "not_pending" };
    } else {
      // Освобождаем все придержанные варианты в любом исходе (чистим options/lockUntil).
      const clear = { options: "", lockUntil: "" };

      if (chosen === null || chosen === undefined || chosen === "") {
        patchRow(b._row, Object.assign({ status: STATUS.CONFIRMED }, clear));
        notifyArgs = { b: b, accepted: false, opt: null };
        result = { ok: true, moved: false };
      } else {
        const i = Number(chosen);
        const opt = (b.options || [])[i];
        if (!opt) {
          result = { ok: false, error: "bad_choice" };
        } else {
          // Перепроверяем, что выбранный слот всё ещё свободен (кроме самой брони).
          const bookings = getBookings();
          if (hasConflict(bookings, b.court, opt.date, opt.time, b.duration, b.id)) {
            patchRow(b._row, Object.assign({ status: STATUS.CONFIRMED }, clear));
            result = { ok: false, error: "occupied" };
          } else {
            patchRow(b._row, Object.assign({ date: opt.date, time: opt.time, status: STATUS.CONFIRMED }, clear));
            const moved = Object.assign({}, b, { date: opt.date, time: opt.time });
            notifyArgs = { b: moved, accepted: true, opt: opt };
            result = { ok: true, moved: true, date: opt.date, time: opt.time };
          }
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
  if (notifyArgs) notifyCoachProposalResolved(notifyArgs.b, notifyArgs.accepted, notifyArgs.opt);
  return result;
}

/* ════════════════ ПРЕДЛОЖЕНИЕ СЛОТА УЧЕНИКУ ИЗ БАЗЫ ════════════════ */

// Тренер предлагает конкретному ученику несколько вариантов времени для НОВОЙ записи
// (тренировка или аренда). Слоты придерживаются на HOLD_MINUTES (статус offered),
// брони ещё нет. Ученик выбирает в чате → бронь создаётся.
// data: { clientId, clientName, service:'coach'|'court', court, duration, options:[{date,time}] }
function makeOffer(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let result, notifyArgs = null;
  try {
    const clientId = String(data.clientId || "").trim();
    const court = String(data.court || "").trim();
    const service = data.service === "coach" ? "coach" : "court";
    const duration = clampDuration(service, Number(data.duration) || 1);
    if (!clientId) {
      result = { ok: false, error: "no_client" };
    } else if (court !== "Корт 6" && court !== "Корт 7") {
      result = { ok: false, error: "bad_court" };
    } else {
      let opts = (data.options || [])
        .map(o => ({ date: String(o.date || "").trim(), time: padTime(String(o.time || "").trim()) }))
        .filter(o => o.date && o.time);
      if (opts.length === 0) {
        result = { ok: false, error: "no_options" };
      } else {
        if (opts.length > 5) opts = opts.slice(0, 5);

        const bookings = getBookings();
        const conflict = opts.find(o => hasConflict(bookings, court, o.date, o.time, duration, null));
        if (conflict) {
          result = { ok: false, error: "occupied", slot: conflict };
        } else {
          const coach = service === "coach" ? (COURT_COACH[court] || "") : "";
          const id = newId();
          const lockUntil = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
          getSheet().appendRow(rowFor({
            id, court, date: "", time: "", duration, service, coach, status: STATUS.OFFERED,
            options: JSON.stringify(opts), lockUntil: lockUntil,
            clientId: clientId, clientName: data.clientName || "", phone: "", username: "",
            notes: "", createdAt: new Date().toISOString()
          }));
          notifyArgs = { b: { id, court, service, coach, duration, clientId }, opts: opts };
          result = { ok: true, id, count: opts.length };
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
  if (notifyArgs) notifyStudentOffer(notifyArgs.b, notifyArgs.opts);
  return result;
}

// Ученик решает по предложению. chosen = индекс варианта, либо null = отказ.
function resolveOffer(id, chosen) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let result, notifyArgs = null;
  try {
    const b = findById(id);
    if (!b || b.status !== STATUS.OFFERED) {
      result = { ok: false, error: "not_pending" };
    } else if (chosen === null || chosen === undefined || chosen === "") {
      patchRow(b._row, { status: STATUS.CANCELLED, options: "", lockUntil: "" });
      notifyArgs = { b: b, taken: false, opt: null };
      result = { ok: true, taken: false };
    } else {
      const opt = (b.options || [])[Number(chosen)];
      if (!opt) {
        result = { ok: false, error: "bad_choice" };
      } else {
        const bookings = getBookings();
        if (hasConflict(bookings, b.court, opt.date, opt.time, b.duration, b.id)) {
          patchRow(b._row, { status: STATUS.CANCELLED, options: "", lockUntil: "" });
          result = { ok: false, error: "occupied" };
        } else {
          patchRow(b._row, { date: opt.date, time: opt.time, status: STATUS.CONFIRMED, options: "", lockUntil: "" });
          const booked = Object.assign({}, b, { date: opt.date, time: opt.time, status: STATUS.CONFIRMED });
          notifyArgs = { b: booked, taken: true, opt: opt };
          result = { ok: true, taken: true, date: opt.date, time: opt.time };
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
  if (notifyArgs) notifyCoachOfferResolved(notifyArgs.b, notifyArgs.taken, notifyArgs.opt);
  return result;
}

// Список учеников из базы (для выбора при предложении). Только для тренеров.
function getClientsList() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Клиенты");
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const seen = {}, out = [];
  rows.forEach(r => {
    const id = String(r[0] || "").trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    out.push({ id: id, name: String(r[1] || "").trim() || ("Игрок " + id), phone: String(r[2] || "").trim() });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Ищет сохранённый телефон клиента в листе "Клиенты" по его Telegram ID.
// Используется, чтобы не спрашивать номер телефона повторно при следующих входах.
function getClientPhone(clientId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Клиенты");
  if (!sheet || sheet.getLastRow() < 2) return "";
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  for (const r of rows) {
    if (String(r[0] || "").trim() === String(clientId).trim()) return String(r[2] || "").trim();
  }
  return "";
}

/* ════════════════ TELEGRAM: ОБРАБОТКА ВХОДЯЩИХ ════════════════ */

function handleTelegram(update) {
  // Кнопки в сообщениях бота
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const data = String(cb.data || "");
    const [verb, id] = data.split(":");

    if (verb === "cancel") {
      const res = cancelBooking(id, false);
      if (res.ok)                       tgAnswer(cb.id, "Запись отменена");
      else if (res.error === "too_late") tgAnswer(cb.id, "Отменить можно не позже чем за " + CANCEL_CUTOFF_HRS + " ч", true);
      else                              tgAnswer(cb.id, "Запись не найдена");

    } else if (verb === "pick") {
      const idx = data.split(":")[2];
      const res = resolveProposal(id, idx);
      if (res.ok && res.moved) {
        tgAnswer(cb.id, "Перенос подтверждён");
        tgSend(chatId, "✅ Готово! Запись перенесена на " + formatDateRu(res.date) + " в " + res.time + ".");
      } else if (res.error === "occupied") {
        tgAnswer(cb.id, "Этот вариант уже заняли", true);
        tgSend(chatId, "К сожалению, этот вариант уже занят. Запись осталась на прежнем месте — попросите тренера предложить другое время.");
      } else {
        tgAnswer(cb.id, "Предложение уже неактуально");
      }

    } else if (verb === "keep") {
      const res = resolveProposal(id, null);
      tgAnswer(cb.id, res.ok ? "Запись осталась прежней" : "Предложение уже неактуально");
      if (res.ok) tgSend(chatId, "Хорошо, оставляем запись на прежнем времени.");

    } else if (verb === "take") {
      const idx = data.split(":")[2];
      const res = resolveOffer(id, idx);
      if (res.ok && res.taken) {
        tgAnswer(cb.id, "Запись создана");
        tgSend(chatId, "✅ Готово! Вы записаны на " + formatDateRu(res.date) + " в " + res.time + ".");
      } else if (res.error === "occupied") {
        tgAnswer(cb.id, "Это время уже заняли", true);
        tgSend(chatId, "К сожалению, это время уже занято. Попросите тренера предложить другое.");
      } else {
        tgAnswer(cb.id, "Предложение уже неактуально");
      }

    } else if (verb === "nope") {
      const res = resolveOffer(id, null);
      tgAnswer(cb.id, res.ok ? "Вы отказались" : "Предложение уже неактуально");
      if (res.ok) tgSend(chatId, "Хорошо, предложение отклонено.");
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  if (msg.contact) {
    saveUser(chatId, msg.contact.first_name || "Игрок", msg.contact.phone_number);
    tgSend(chatId, "Спасибо! Открывайте календарь бронирования 🎾", openBtn());
    return;
  }

  if (msg.text === "/start" && msg.chat.type === "private") {
    tgSend(chatId, "Добро пожаловать в Tennis Pro! 🎾\nОткройте календарь, чтобы записаться.", openBtn());
  }
}

/* ════════════════ TELEGRAM: УВЕДОМЛЕНИЯ ════════════════ */

// Кому слать уведомление по событию на корте: тренеру этого корта (его личный
// чат), иначе — в админский чат. Так и аренда, и тренировка уходят нужному тренеру.
function chatsForCourt(court) {
  const coach = COURT_COACH[court];
  if (coach && COACH_CHAT[coach]) return [COACH_CHAT[coach]];
  return ADMIN_CHAT_IDS;
}

function serviceLabel(b) {
  if (b.service === "coach") return "Тренировка с тренером " + (b.coach || "");
  if (b.service === "block") return "Закрытый слот";
  return "Аренда корта";
}

// Подтверждение ученику в чат бота (если он из Telegram — есть clientId).
function notifyStudentNewBooking(b) {
  if (!b.clientId) return;
  const dur = b.duration > 1 ? " · " + b.duration + " ч" : "";
  tgSend(b.clientId,
    "✅ Вы записаны!\n━━━━━━━━━━━━\n" +
    "🎾 " + serviceLabel(b) + "\n" +
    "🏟 " + b.court + "\n" +
    "📅 " + formatDateRu(b.date) + " в " + b.time + dur + "\n━━━━━━━━━━━━\n" +
    "Отменить или перенести можно в приложении (не позднее чем за " + CANCEL_CUTOFF_HRS + " ч). Напомним за " + REMINDER_HOURS + " ч.",
    openBtn());
}

function notifyCoachNewBooking(b) {
  const dur = b.duration > 1 ? " · " + b.duration + " ч" : "";
  const text =
    "🎾 Новая запись\n━━━━━━━━━━━━\n" +
    "📋 " + serviceLabel(b) + "\n" +
    "🏟 " + b.court + "\n" +
    "📅 " + formatDateRu(b.date) + " в " + b.time + dur + "\n━━━━━━━━━━━━\n" +
    "👤 " + (b.clientName || "—") +
    (b.username ? " (@" + b.username + ")" : "") + "\n" +
    (b.phone ? "📞 " + b.phone + "\n" : "") +
    (b.notes ? "📝 " + b.notes : "");
  chatsForCourt(b.court).forEach(id => tgSend(id, text));
}

function notifyCancellation(b, byCoach) {
  const dur = b.duration > 1 ? " · " + b.duration + " ч" : "";
  const who = byCoach ? "тренером" : "клиентом";
  const text =
    "❌ Отмена записи (" + who + ")\n" +
    serviceLabel(b) + "\n" + b.court + "\n" +
    formatDateRu(b.date) + " в " + b.time + dur + "\n" +
    "Клиент: " + (b.clientName || "—") + (b.username ? " (@" + b.username + ")" : "");
  chatsForCourt(b.court).forEach(id => tgSend(id, text));

  // Сообщаем клиенту (если отменил тренер — клиенту особенно важно знать).
  if (b.clientId) {
    tgSend(b.clientId,
      "Ваша запись отменена:\n🎾 " + serviceLabel(b) + "\n📅 " + formatDateRu(b.date) + " в " + b.time +
      "\n\nХотите записаться на другое время — откройте календарь.",
      openBtn());
  }
}

function notifyStudentProposal(b, opts) {
  if (!b.clientId) return;
  const dur = b.duration > 1 ? " · " + b.duration + " ч" : "";
  let text = "🔄 Тренер предлагает перенести вашу запись\n\n" +
    "Сейчас: " + formatDateRu(b.date) + " в " + b.time + dur + "\n🏟 " + b.court + "\n\n" +
    "Выберите удобный вариант (он закреплён на " + HOLD_MINUTES + " минут):";
  const rows = opts.map((o, i) => ([
    { text: "✅ " + formatDateRu(o.date) + " в " + o.time, callback_data: "pick:" + b.id + ":" + i }
  ]));
  rows.push([{ text: "Оставить как есть", callback_data: "keep:" + b.id }]);
  tgSend(b.clientId, text, { inline_keyboard: rows });
}

// Заявка на перетяжку струн — это не бронь корта, просто уведомление тренерам.
function notifyStringing(d) {
  // Телефон обязателен и должен быть правдоподобным (8–15 цифр).
  const pd = String(d.phone || "").replace(/\D/g, "");
  if (pd.length < 8 || pd.length > 15) return { ok: false, error: "bad_phone" };
  const mode = d.mode === "trust" ? "Доверяется мастеру" : "Подробная форма";
  const text =
    "🎯 Заявка на перетяжку струн\n" +
    "Клиент: " + (d.clientName || d.name || "—") +
    (d.username ? " (@" + d.username + ")" : "") +
    (d.phone ? " · " + d.phone : "") + "\n" +
    "Ракетка: " + (d.racket || "—") + "\n" +
    "Оформление: " + mode +
    (d.tension    ? "\nНатяжение: " + d.tension    : "") +
    (d.stringType ? "\nТип струн: " + d.stringType : "") +
    (d.style      ? "\nСтиль игры: " + d.style     : "");
  ADMIN_CHAT_IDS.forEach(id => tgSend(id, text));
  return { ok: true };
}

function notifyCoachProposalResolved(b, accepted, opt) {
  const when = accepted
    ? "на " + formatDateRu(opt.date) + " в " + opt.time
    : "(оставлена на " + formatDateRu(b.date) + " в " + b.time + ")";
  const text = (accepted ? "✅ Студент выбрал перенос " : "↩️ Студент оставил запись ") +
    (b.clientName || "") + " " + when;
  chatsForCourt(b.court).forEach(id => tgSend(id, text));
}

// Предложение нового слота ученику (тренировка/корт) с кнопками выбора.
function notifyStudentOffer(b, opts) {
  if (!b.clientId) return;
  const what = b.service === "coach"
    ? ("тренировку с тренером " + (b.coach || ""))
    : "аренду корта";
  const dur = b.duration > 1 ? " · " + b.duration + " ч" : "";
  const text = "🎾 Тренер предлагает вам " + what + " на " + b.court + dur + "\n\n" +
    "Выберите удобное время (закреплено на " + HOLD_MINUTES + " минут):";
  const rows = opts.map((o, i) => ([
    { text: "✅ " + formatDateRu(o.date) + " в " + o.time, callback_data: "take:" + b.id + ":" + i }
  ]));
  rows.push([{ text: "Отказаться", callback_data: "nope:" + b.id }]);
  tgSend(b.clientId, text, { inline_keyboard: rows });
}

function notifyCoachOfferResolved(b, taken, opt) {
  const text = taken
    ? ("✅ " + (b.clientName || "Ученик") + " принял предложение: " + formatDateRu(opt.date) + " в " + opt.time + " · " + b.court)
    : ("↩️ " + (b.clientName || "Ученик") + " отклонил предложение времени.");
  chatsForCourt(b.court).forEach(id => tgSend(id, text));
}

/* ════════════════ TELEGRAM: НИЗКОУРОВНЕВОЕ API ════════════════ */

function openBtn() {
  return { inline_keyboard: [[{ text: "📅 Открыть календарь", web_app: { url: WEBAPP_URL } }]] };
}

function tgSend(chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text: text };
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);
  UrlFetchApp.fetch("https://api.telegram.org/bot" + TOKEN + "/sendMessage", {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
}

function tgAnswer(callbackQueryId, text, alert) {
  UrlFetchApp.fetch("https://api.telegram.org/bot" + TOKEN + "/answerCallbackQuery", {
    method: "post", contentType: "application/json",
    payload: JSON.stringify({ callback_query_id: callbackQueryId, text: text, show_alert: !!alert }),
    muteHttpExceptions: true
  });
}

/* ════════════════ КЛИЕНТЫ / ПРИВЕТСТВИЕ ════════════════ */

function saveUser(chatId, name, phone) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Клиенты");
  if (!sheet) { sheet = ss.insertSheet("Клиенты"); sheet.appendRow(["Telegram ID", "Имя", "Телефон", "Дата"]); }
  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) if (String(values[r][0]) === String(chatId)) return;
  sheet.appendRow([String(chatId), name, phone, Utilities.formatDate(new Date(), TZ, "dd.MM.yyyy HH:mm")]);
}

function sendWelcomeIfNew(chatId, name) {
  if (!chatId) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Стартовавшие");
  if (!sheet) { sheet = ss.insertSheet("Стартовавшие"); sheet.appendRow(["chatId", "date"]); }
  const values = sheet.getDataRange().getValues();
  for (let r = 0; r < values.length; r++) if (String(values[r][0]).trim() === String(chatId).trim()) return;
  sheet.appendRow([String(chatId), Utilities.formatDate(new Date(), TZ, "dd.MM.yyyy HH:mm")]);
  tgSend(chatId,
    (name ? "Привет, " + name + "! 👋" : "Привет! 👋") +
    "\n\nДобро пожаловать в Tennis Pro 🎾\nЗдесь будут напоминания о тренировках, и отсюда можно отменить запись (не позже чем за " +
    CANCEL_CUTOFF_HRS + " часов).\n\nДо встречи на корте!",
    openBtn());
}

/* ════════════════ НАПОМИНАНИЯ И ОЧИСТКА (триггеры) ════════════════ */

function setupReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "sendReminders") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendReminders").timeBased().everyHours(1).create();
  Logger.log("Триггер напоминаний создан.");
}

function sendReminders() {
  releaseExpiredHolds();
  getBookings().forEach(b => {
    if (b.status !== STATUS.CONFIRMED || !b.clientId || b.service === "block") return;
    const diff = hoursUntil(b.date, b.time);
    if (diff > REMINDER_HOURS && diff <= REMINDER_HOURS + 1) {
      const dur = b.duration > 1 ? " · " + b.duration + " ч" : "";
      const canCancel = diff >= CANCEL_CUTOFF_HRS;
      const buttons = [];
      if (canCancel) buttons.push([{ text: "❌ Отменить запись", callback_data: "cancel:" + b.id }]);
      buttons.push([{ text: "🔄 Перенести / открыть", web_app: { url: WEBAPP_URL } }]);
      tgSend(b.clientId,
        "⏰ Напоминание!\n\n🎾 " + serviceLabel(b) + "\n🏟 " + b.court +
        "\n📅 " + formatDateRu(b.date) + " в " + b.time + dur + "\n\nЖдём вас!",
        { inline_keyboard: buttons });
    }
  });
}

// Снимает просрочившие блокировки: proposed с истёкшим lockUntil → confirmed,
// варианты очищаются, придержанные слоты освобождаются. Бронь остаётся на месте.
function releaseExpiredHolds() {
  getBookings().forEach(b => {
    if (!holdActive(b)) {
      if (b.status === STATUS.PROPOSED) patchRow(b._row, { status: STATUS.CONFIRMED, options: "", lockUntil: "" });
      else if (b.status === STATUS.OFFERED) patchRow(b._row, { status: STATUS.CANCELLED, options: "", lockUntil: "" });
    }
  });
}

function setupCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "cleanOldBookings") ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger("cleanOldBookings").timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  Logger.log("Триггер очистки создан.");
}

// Удаляет строки старше 30 дней (по реальной дате). Идём снизу вверх.
function cleanOldBookings() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  const idx = {}; values[0].forEach((h, i) => idx[String(h).trim()] = i);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = Utilities.formatDate(cutoff, TZ, "yyyy-MM-dd");
  for (let r = values.length - 1; r >= 1; r--) {
    const d = asText(values[r][idx.date]);
    if (d && d < cutoffStr) sheet.deleteRow(r + 1);
  }
  Logger.log("Очистка завершена до " + cutoffStr);
}

/* ════════════════ ПОЛУЧЕНИЕ ОБНОВЛЕНИЙ ОТ TELEGRAM: POLLING (не вебхук) ════════════════
 *
 * ВАЖНО: веб-приложения Apps Script (URL вида .../exec) при ЛЮБОМ обращении сперва
 * отвечают HTTP 302 (редирект на script.googleusercontent.com) — это особенность самой
 * платформы, в коде это не убрать. Обычные HTTP-клиенты (браузер, fetch() из мини-аппа)
 * молча проходят этот редирект сами, поэтому бронирование всегда работало нормально.
 * А вот вебхук-механизм Telegram редиректы НЕ проходит: получив 302 вместо прямого 200,
 * он считает доставку неуспешной и повторяет ТОТ ЖЕ апдейт снова и снова — отсюда был
 * спам сообщений и "Wrong response from the webhook: 302" в getWebhookInfo.
 *
 * Поэтому вместо вебхука Apps Script сам, по расписанию, СПРАШИВАЕТ у Telegram
 * "что нового" (getUpdates) — здесь скрипт выступает клиентом, а не сервером,
 * и проблема редиректа просто не возникает.
 */

const TG_OFFSET_PROP = "tg_update_offset";

// Вызывается триггером раз в минуту. Забирает новые апдейты и прогоняет их
// через тот же handleTelegram(), что раньше вызывался из doPost().
function pollUpdates() {
  const props = PropertiesService.getScriptProperties();
  const offset = Number(props.getProperty(TG_OFFSET_PROP) || 0);
  const res = UrlFetchApp.fetch(
    "https://api.telegram.org/bot" + TOKEN + "/getUpdates?offset=" + (offset + 1) + "&timeout=0",
    { muteHttpExceptions: true }
  );
  let json;
  try { json = JSON.parse(res.getContentText()); } catch (e) { Logger.log("pollUpdates: bad response " + e); return; }
  if (!json.ok || !Array.isArray(json.result) || json.result.length === 0) return;

  let maxId = offset;
  json.result.forEach(update => {
    try { handleTelegram(update); } catch (err) { Logger.log("pollUpdates handleTelegram error: " + err); }
    if (update.update_id > maxId) maxId = update.update_id;
  });

  // PropertiesService изредка отвечает временным "Data storage error" — это сбой
  // внутренней инфраструктуры Google, само проходит при повторной попытке. Если не
  // подстраховаться, такой сбой оставит офсет несохранённым, и следующий запуск
  // заново обработает уже отправленные апдейты — то есть продублирует сообщения.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      props.setProperty(TG_OFFSET_PROP, String(maxId));
      return;
    } catch (err) {
      Logger.log("pollUpdates: setProperty попытка " + attempt + " не удалась: " + err);
      if (attempt < 3) Utilities.sleep(500);
    }
  }
}

// ЗАПУСТИ ОДИН РАЗ ВРУЧНУЮ (выбери функцию в списке сверху → ▶️ запустить):
// снимает старый вебхук (иначе Telegram не даёт параллельно пользоваться getUpdates —
// вернёт ошибку 409 Conflict) и ставит триггер на каждую минуту.
function switchToPolling() {
  const del = UrlFetchApp.fetch("https://api.telegram.org/bot" + TOKEN + "/deleteWebhook", { muteHttpExceptions: true });
  Logger.log("deleteWebhook: " + del.getContentText());
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "pollUpdates") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("pollUpdates").timeBased().everyMinutes(1).create();
  Logger.log("Вебхук снят, polling запущен (раз в минуту).");
}

// Старая функция вебхука. БОЛЬШЕ НЕ ИСПОЛЬЗУЕТСЯ (см. switchToPolling выше) —
// оставлена только для истории, вызывать её не нужно, иначе вебхук снова включится
// и спам с 302 вернётся.
function setWebhook() {
  const DEPLOY_URL = "https://script.google.com/macros/s/AKfycbyiSZhoouByR9YpDA5uuFcr2MRiGnqqAcEFe7KM29NJ2y60IbIWEdmrqlHMZmOFOdM63A/exec";
  const res = UrlFetchApp.fetch("https://api.telegram.org/bot" + TOKEN + "/setWebhook", {
    method: "post", contentType: "application/json",
    payload: JSON.stringify({ url: DEPLOY_URL, allowed_updates: ["message", "callback_query"] }),
    muteHttpExceptions: true
  });
  Logger.log(res.getContentText());
}

/* ════════════════ ВСПОМОГАТЕЛЬНОЕ ════════════════ */

function rowFor(obj) { return COLUMNS.map(c => obj[c] !== undefined ? obj[c] : ""); }

// options хранится как JSON-текст [{date,time}]. Безопасно разбираем в массив.
function parseOptions(v) {
  if (!v) return [];
  try { const a = JSON.parse(String(v)); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}

function newId() {
  return "b" + Utilities.formatDate(new Date(), TZ, "yyMMddHHmmss") + Math.floor(Math.random() * 1000);
}

function clampDuration(service, n) {
  const max = MAX_DURATION[service] || 1;
  n = Number(n) || 1;
  if (service === "court") {
    // Для аренды корта разрешены только 1 / 1.5 / 2 часа.
    if (COURT_DURATIONS.indexOf(n) === -1) n = 1;
    return Math.min(n, max);
  }
  return Math.min(Math.max(1, Math.round(n)), max);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Текст как есть; Date переводим в yyyy-MM-dd (на случай если ячейка всё же стала датой).
function asText(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  return String(v == null ? "" : v).trim();
}

// Нормализуем время в "HH:MM" даже если Google превратил его в дату/дробь.
function asTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "HH:mm");
  if (typeof v === "number" && v >= 0 && v < 1) {
    const m = Math.round(v * 24 * 60);
    return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
  }
  return padTime(String(v).trim());
}

function padTime(s) { return s.match(/^\d:\d{2}$/) ? "0" + s : s; } // "9:00" -> "09:00"
function pad2(n)    { return String(n).padStart(2, "0"); }
function toMinutes(t)   { const [h, m] = padTime(t).split(":").map(Number); return h * 60 + m; }
function fromMinutes(x) { return pad2(Math.floor(x / 60)) + ":" + pad2(x % 60); }

// Сколько часов от "сейчас" до брони (date "yyyy-MM-dd", time "HH:MM").
function hoursUntil(date, time) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = padTime(time).split(":").map(Number);
  const when = new Date(y, mo - 1, d, h, mi, 0);
  return (when - new Date()) / 3600000;
}

function formatDateRu(dateStr) {
  if (!dateStr || dateStr.indexOf("-") === -1) return dateStr;
  const [y, m, d] = dateStr.split("-");
  const months = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
  return d + " " + months[parseInt(m, 10) - 1] + " " + y;
}