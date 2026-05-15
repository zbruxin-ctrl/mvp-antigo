"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OTPParser = void 0;
const node_fetch_1 = __importDefault(require("node-fetch"));
const globalState_1 = require("../state/globalState");
// ─── Resolve iframe src e retorna o HTML interno ─────────────────────────────
async function resolveIframeContent(html) {
    // Extrai todos os src de <iframe ...>
    const iframeSrcs = [];
    const re = /<iframe[^>]+src=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const src = m[1].trim();
        if (src.startsWith('http'))
            iframeSrcs.push(src);
    }
    if (iframeSrcs.length === 0)
        return html; // sem iframe, retorna original
    const parts = [html]; // mantém o HTML original também
    for (const src of iframeSrcs) {
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 10000);
            const res = await (0, node_fetch_1.default)(src, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OTPBot/1.0)' },
            });
            clearTimeout(tid);
            if (res.ok) {
                const text = await res.text();
                globalState_1.globalState.addLog('info', `📄 [iframe] Conteúdo obtido de ${src.slice(0, 80)} (${text.length} chars)`);
                parts.push(text);
            }
            else {
                globalState_1.globalState.addLog('warn', `⚠️ [iframe] HTTP ${res.status} ao buscar ${src.slice(0, 80)}`);
            }
        }
        catch (e) {
            globalState_1.globalState.addLog('warn', `⚠️ [iframe] Erro ao buscar iframe src: ${e instanceof Error ? e.message : e}`);
        }
    }
    return parts.join('\n');
}
class OTPParser {
    static extractOTP(text) {
        // 1) Remove tags HTML
        const noBreaks = text.replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
        const clean = noBreaks
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&#[0-9]+;/g, ' ')
            .replace(/&[a-z]+;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        // 2) Padrão primário: palavra-chave + número
        const primary = clean.match(/(?:c[oó]digo|code|otp|pin|verif[a-z]*|confirma[a-z]*)[^0-9]{0,60}([0-9]{4,8})/i);
        if (primary?.[1]) {
            globalState_1.globalState.addLog('success', `🔢 OTP extraído (primary): ${primary[1]}`);
            return primary[1];
        }
        // 3) Dígitos separados por espaço/traço (ex: "1 2 3 4" ou "1-2-3-4")
        const spaced = clean.match(/\b([0-9][\s\-][0-9][\s\-][0-9][\s\-][0-9])\b/);
        if (spaced?.[1]) {
            const joined = spaced[1].replace(/[\s\-]/g, '');
            globalState_1.globalState.addLog('success', `🔢 OTP extraído (spaced digits): ${joined}`);
            return joined;
        }
        // 4) Número isolado de 4-6 dígitos
        const isolated = clean.match(/(?:^|[^0-9])([0-9]{4,6})(?:[^0-9]|$)/);
        if (isolated?.[1]) {
            const num = isolated[1];
            if (!/^(19|20)[0-9]{2}$/.test(num)) {
                globalState_1.globalState.addLog('info', `🔢 OTP extraído (isolated): ${num}`);
                return num;
            }
        }
        // 5) Fallback: primeiro bloco de 4 dígitos que não seja ano
        const allNums = [...clean.matchAll(/(?:^|[^0-9])([0-9]{4,6})(?:[^0-9]|$)/g)];
        for (const m of allNums) {
            const num = m[1];
            if (!/^(19|20)[0-9]{2}$/.test(num)) {
                globalState_1.globalState.addLog('info', `🔢 OTP fallback: ${num}`);
                return num;
            }
        }
        return null;
    }
    static async extractFromMessageAsync(message) {
        // Resolve iframes antes de tentar extrair
        const htmlResolved = message.mail_html
            ? await resolveIframeContent(message.mail_html)
            : '';
        const sources = [
            htmlResolved,
            message.mail_text,
            message.mail_preview,
        ];
        for (const src of sources) {
            if (src && src.trim().length > 0) {
                const otp = this.extractOTP(src);
                if (otp)
                    return otp;
            }
        }
        globalState_1.globalState.addLog('warn', `⚠️ OTP não encontrado no email (subject: "${message.mail_subject}")`);
        return null;
    }
    /** @deprecated use extractFromMessageAsync */
    static extractFromMessage(message) {
        const sources = [message.mail_html, message.mail_text, message.mail_preview];
        for (const src of sources) {
            if (src && src.trim().length > 0) {
                const otp = this.extractOTP(src);
                if (otp)
                    return otp;
            }
        }
        globalState_1.globalState.addLog('warn', `⚠️ OTP não encontrado no email (subject: "${message.mail_subject}")`);
        return null;
    }
}
exports.OTPParser = OTPParser;
//# sourceMappingURL=otpParser.js.map