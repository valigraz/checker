const puppeteer = require("puppeteer");

// ---- CONFIG ----
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const STEP_TIMEOUT = 15_000;
const HEARTBEAT_HOURS = [4, 20]; // UTC hours. Vilnius time +2 hours
const NOT_FOUND_NOTIFY_HOURS = [11]; // UTC hours. Vilnius time +2 hours

const SEARCH_INPUTS = {
    search_1: {
        MUNI_TEXT: 'Vilniaus m. sav.',
        MUNI_SEARCH: 'Vilniaus',
        PRACT_TEXT: '',
        PRACT_SEARCH: '',
        SERVICE_TEXT: 'Oftalmologija (Okuloplastinė chirurgija, vokų, ašarų takų, junginės, akiduobės patologija) II lygis',
        SERVICE_SEARCH: 'Oftalmologija',
        TARGET_RESULT_TEXT: 'Vilniaus universiteto ligoninė Santaros klinikos, VšĮ',
        // earliest date inputs
        EARLIEST_DATE: false,
        DAYS_AHEAD: null,
        EXCLUDE_ORGANIZATIONS: []
    },
    // search_1: {
    //     MUNI_TEXT: 'Vilniaus m. sav.',
    //     MUNI_SEARCH: 'Vilniaus',
    //     PRACT_TEXT: '',
    //     PRACT_SEARCH: '',
    //     SERVICE_TEXT: 'Fizinės medicinos ir reabilitacijos gydytojo konsultacija (Vaikams) II lygis',
    //     SERVICE_SEARCH: 'Fizinės medicinos',
    //     TARGET_RESULT_TEXT: 'Antakalnio poliklinika',
    //     // earliest date inputs
    //     EARLIEST_DATE: true,
    //     DAYS_AHEAD: 2,
    //     EXCLUDE_ORGANIZATIONS: ['Euromed klinika, Sanum medicale, UAB', 'Viešoji įstaiga Vilniaus rajono poliklinika']
    // },
    search_2: {
        MUNI_TEXT: 'Vilniaus m. sav.',
        MUNI_SEARCH: 'Vilniaus',
        PRACT_TEXT: 'RIMA PIKŪNIENĖ(Vilniaus universiteto ligoninė Santaros klinikos, VšĮ)',
        PRACT_SEARCH: 'RIMA PIKŪN',
        SERVICE_TEXT: '',
        SERVICE_SEARCH: '',
        TARGET_RESULT_TEXT: 'Stacionarinė reabilitacija su slauga (Vaikams)',
        // earliest date inputs
        EARLIEST_DATE: false,
        DAYS_AHEAD: null,
        EXCLUDE_ORGANIZATIONS: []
    }
}

// ---- TELEGRAM (hardcoded) ----
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramPhoto(caption, pngBuffer) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('[WARN] Telegram not configured. Would send photo with caption:', caption);
        return;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
    
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([pngBuffer], { type: 'image/png' }), 'proof.png');

    const res = await fetch(url, { method: 'POST', body: form });
    
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Telegram sendPhoto ${res.status}: ${txt}`);
    }
}

async function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('[WARN] Telegram not configured. Would send message:', message);
        return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        })
    });
    
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Telegram sendMessage ${res.status}: ${txt}`);
    }
}

// ---- HELPERS ----
async function selectNgOption(page, rootSel, searchFragment, exactText, timeout = STEP_TIMEOUT) {
    await page.waitForSelector(`${rootSel} .ng-select-container`, { visible: true, timeout });
    await page.click(`${rootSel} .ng-select-container`);
    await page.waitForSelector(`${rootSel} .ng-input input`, { visible: true, timeout });

    if (searchFragment) {
        await page.focus(`${rootSel} .ng-input input`);
        await page.keyboard.down(MOD); await page.keyboard.press('KeyA'); await page.keyboard.up(MOD);
        await page.keyboard.press('Backspace');
        await page.type(`${rootSel} .ng-input input`, searchFragment, { delay: 35 });
    }

    const panelId = await page
        .waitForFunction((root) => {
            const el = document.querySelector(`${root} .ng-input`);
            return el?.getAttribute('aria-owns') || null;
        }, { timeout }, rootSel)
        .then(h => h.jsonValue())
        .catch(() => null);

    await page.waitForFunction((pid, text) => {
        const norm = s => s.replace(/\s+/g, ' ').trim();
        const scope = pid ? document.getElementById(pid) : document.body;
        if (!scope) return false;
        return Array.from(scope.querySelectorAll('.ng-option .ng-option-label'))
            .some(el => norm(el.textContent) === norm(text));
    }, { timeout }, panelId, exactText);

    await page.evaluate((pid, text) => {
        const norm = s => s.replace(/\s+/g, ' ').trim();
        const scope = pid ? document.getElementById(pid) : document.body;
        const label = Array.from(scope.querySelectorAll('.ng-option .ng-option-label'))
            .find(el => norm(el.textContent) === norm(text));
        if (label) label.closest('.ng-option').click();
    }, panelId, exactText);

    const selected = await page
        .waitForFunction((root) => {
            const vc = document.querySelector(`${root} .ng-value-container`);
            const txt = vc?.textContent?.replace(/\s+/g, ' ').trim();
            return txt && txt.length > 0 ? txt : null;
        }, { timeout }, rootSel)
        .then(h => h.jsonValue())
        .catch(() => '');

    return selected;
}

async function readControlValue(page, rootSel) {
    return page
        .evaluate((root) => {
            const txt = document.querySelector(`${root} .ng-value-container`)?.textContent || '';
            return txt.replace(/\s+/g, ' ').trim();
        }, rootSel)
        .catch(() => '');
}

async function ensureSelected(page, rootSel, expectedExact, searchFragment) {
    const current = await readControlValue(page, rootSel);
    if (current && current.includes(expectedExact)) return current;
    return selectNgOption(page, rootSel, searchFragment, expectedExact);
}

async function waitForTextAnywhere(page, text, timeout = 30000) {
    const ok = await page
        .waitForFunction((t) => {
            const norm = (s) =>
                (s || '')
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase();
            const bodyText = norm(document.body?.innerText);
            return bodyText.includes(norm(t));
        }, { timeout }, text)
        .then(() => true)
        .catch(() => false);
    return ok;
}

async function waitForDateInTable(page, DAYS_AHEAD, EXCLUDE_ORGANIZATIONS, timeout = 8000) {
  const REQUIRED_NEED = "Ligonių kasos";
  const TABLE_SELECTOR = "table.table tbody";

  // Vilnius local "today + next 5 days" (inclusive)
  const now = new Date();
  const vilniusNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Vilnius" })
  );

  // Build allowed YYYY-MM-DD strings for today..today+4
  const allowedDates = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const dt = new Date(vilniusNow);
    dt.setDate(dt.getDate() + i);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    allowedDates.push(`${y}-${m}-${d}`);
  }

  const ok = await page
    .waitForFunction(
      ({ TABLE_SELECTOR, REQUIRED_NEED, EXCLUDE_ORGANIZATIONS, allowedDates }) => {
        const tbody = document.querySelector(TABLE_SELECTOR);
        if (!tbody) return false;

        const rows = Array.from(tbody.querySelectorAll("tr"));
        for (const tr of rows) {
          const tds = tr.querySelectorAll("td");
          if (tds.length < 5) continue;

          const orgCell = (tds[0].textContent || "").trim();
          if (
            Array.isArray(EXCLUDE_ORGANIZATIONS) &&
            EXCLUDE_ORGANIZATIONS.length > 0 &&
            EXCLUDE_ORGANIZATIONS.some((v) => orgCell.includes(v))
          ) {
            continue; // skip excluded orgs, don't stop waiting
          }

          const need = (tds[2].textContent || "").replace(/\s+/g, " ").trim();
          if (need !== REQUIRED_NEED) continue;

          const timeText = (tds[4].textContent || "").replace(/\s+/g, " ").trim();
          const match = timeText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
          if (!match) continue;

          const dateStr = match[1];
          if (allowedDates.includes(dateStr)) return true;
        }

        return false; // keep waiting
      },
      { timeout },
      { TABLE_SELECTOR, REQUIRED_NEED, EXCLUDE_ORGANIZATIONS, allowedDates }
    )
    .then(() => true)
    .catch(() => false);

  return ok;
}

function sendHeartbeat(heartBeatHours) {
    const now = new Date();

    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    return heartBeatHours.includes(hour) && minute < 2;
}

// ---- MAIN ----
(async () => {
    const url = 'https://ipr.esveikata.lt/';

    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1366, height: 900 },
        args: [ '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage' ],
    });

    try {
        const page1 = await browser.createBrowserContext().then(c => c.newPage());
        const page2 = await browser.createBrowserContext().then(c => c.newPage());

        await Promise.all([
            page1.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }),
            page2.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }),
        ]);

        const runSearchAndCheck = async (page, {MUNI_TEXT, MUNI_SEARCH, PRACT_TEXT, PRACT_SEARCH, SERVICE_TEXT, SERVICE_SEARCH, TARGET_RESULT_TEXT, EARLIEST_DATE, DAYS_AHEAD, EXCLUDE_ORGANIZATIONS}) => {            
            const muni = await ensureSelected(page, '#municipalityInput', MUNI_TEXT, MUNI_SEARCH);
            console.log('Municipality selected:', muni);

            if (PRACT_TEXT) {
                const service = await ensureSelected(page, '#practitionerInput', PRACT_TEXT, PRACT_SEARCH);
                console.log('Practitioner selected:', service);
            }

            if (SERVICE_TEXT) {
                const service = await ensureSelected(page, '#serviceInput', SERVICE_TEXT, SERVICE_SEARCH);
                console.log('Service selected:', service);
            }
            
            await page.click("#searchButton").catch(() => { });
            let found;

            if (EARLIEST_DATE) {
                found = await waitForDateInTable(page, DAYS_AHEAD, EXCLUDE_ORGANIZATIONS, 8000);
            } else {
                found = await waitForTextAnywhere(page, TARGET_RESULT_TEXT, 8000);
            }

            const ts = new Date().toISOString();
            if (EARLIEST_DATE) {
                console.log(`[${ts}] ${found ? 'FOUND' : 'NOT FOUND'} — "${SERVICE_SEARCH}"`);
            } else {
                console.log(`[${ts}] ${found ? 'FOUND' : 'NOT FOUND'} — "${TARGET_RESULT_TEXT}"`);
            }

            if (found) {
                const ltTime = new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' });
                const caption =
                    `✅ <b>Rasta paslauga</b>\n` +
                    `Savivaldybė: ${MUNI_TEXT}\n` +
                    `Paslauga: ${EARLIEST_DATE ? SERVICE_SEARCH : TARGET_RESULT_TEXT}\n` +
                    `Laikas: ${ltTime}`;

                try {
                    const png = await page.screenshot({ fullPage: true });
                    await sendTelegramPhoto(caption, png);
                    console.log('[TG] Photo notification sent.');
                } catch (e) {
                    console.error('[TG] Photo send failed:', e.message);
                }
            } else if (sendHeartbeat(NOT_FOUND_NOTIFY_HOURS)) {
                const ltTime = new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' });
                const caption =
                    `<b>Not found</b>\n` +
                    `Paslauga: ${EARLIEST_DATE ? SERVICE_SEARCH : TARGET_RESULT_TEXT}\n` +
                    `Savivaldybė: ${MUNI_TEXT}\n` +
                    `Laikas: ${ltTime}`;

                try {
                    const png = await page.screenshot({ fullPage: true });
                    await sendTelegramPhoto(caption, png);
                    console.log('[TG] Photo notification sent.');
                } catch (e) {
                    console.error('[TG] Photo send failed:', e.message);
                }
            }
        };

        await Promise.all([
            runSearchAndCheck(page1, SEARCH_INPUTS.search_1),
            runSearchAndCheck(page2, SEARCH_INPUTS.search_2),
        ]);

        if (sendHeartbeat(HEARTBEAT_HOURS)) {
            const ltTime = new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' });
            const message = `<b>🟢 OK</b> ${ltTime}`;

            try {
                await sendTelegramMessage(message);
                console.log('[TG] Message notification sent.');
            } catch (e) {
                console.error('[TG] Message send failed:', e.message);
            }
        }
    } catch (err) {
        console.error("[ERROR] ", err);
    } finally {
        await browser.close();
    }
})();
