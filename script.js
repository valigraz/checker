const puppeteer = require("puppeteer");
const { Blob } = require("buffer");
const FormData = require("form-data");

// ---- CONFIG ----
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const MUNI_TEXT = 'Vilniaus m. sav.';
const MUNI_SEARCH = 'Vilniaus';

const PRACT_TEXT = null; //'RIMA PIKŪNIENĖ(Vilniaus universiteto ligoninė Santaros klinikos, VšĮ)';
const PRACT_SEARCH = null; //'RIMA PIKŪN';

const SERVICE_TEXT = 'Fizinės medicinos ir reabilitacijos gydytojo konsultacija (Vaikams) II lygis';
const SERVICE_SEARCH = 'Fizinės medicinos';

const TARGET_RESULT_TEXT = 'Antakalnio poliklinika'; //'Stacionarinė reabilitacija su slauga (Vaikams)';
const STEP_TIMEOUT = 15_000;

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
        const txt = await res.text().catch(() => '');
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

function sendHeartbeat() {
    const now = new Date();

    const hour = now.getUTCHours();    // or local time if you prefer
    const minute = now.getUTCMinutes();

    const heartBeatHours = [6, 9, 13, 21];

    return heartBeatHours.includes(hour) && minute < 5;
}

// ---- MAIN ----
(async () => {
    const url = 'https://ipr.esveikata.lt/';

    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1366, height: 900 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
    });

    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const muni = await ensureSelected(page, '#municipalityInput', MUNI_TEXT, MUNI_SEARCH);
        console.log('Municipality selected:', muni);

        if (PRACT_TEXT) {
            const practitioner = await ensureSelected(page, '#practitionerInput', PRACT_TEXT, PRACT_SEARCH);
            console.log('Practitioner selected:', practitioner);
        }
    
        if (SERVICE_TEXT) {
            const service = await ensureSelected(page, '#serviceInput', SERVICE_TEXT, SERVICE_SEARCH);
            console.log('Practitioner selected:', service);
        }

        await page.click("#searchButton").catch(() => { });
        const found = await waitForTextAnywhere(page, TARGET_RESULT_TEXT, 30000);

        const ts = new Date().toISOString();
        console.log(`[${ts}] ${found ? 'FOUND' : 'NOT FOUND'} — "${TARGET_RESULT_TEXT}"`);

        if (found) {
            const ltTime = new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' });
            const caption =
                `✅ <b>Rasta paslauga</b>\n` +
                `Paslauga:${TARGET_RESULT_TEXT}\n` +
                `Savivaldybė: ${MUNI_TEXT}\n` +
                `Gydytojas: ${PRACT_TEXT}\n` +
                `${url}\n` +
                `Laikas: ${ltTime}`;

            try {
                const png = await page.screenshot({ fullPage: true });
                await sendTelegramPhoto(caption, png);
                console.log('[TG] Photo notification sent.');
            } catch (e) {
                console.error('[TG] Photo send failed:', e.message);
            }
        } else {
            if (sendHeartbeat()) {
                const ltTime = new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' });
                const message =
                    `<b>🟢 OK</b> ${ltTime}`;
    
                try {
                    await sendTelegramMessage(message);
                    console.log('[TG] Message notification sent.');
                } catch (e) {
                    console.error('[TG] Message send failed:', e.message);
                }
            }
        }

    } catch (err) {
        console.error("[ERROR] ", err);
    } finally {
        await browser.close();
    }
})();
