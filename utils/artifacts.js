"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArtifactsManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const globalState_1 = require("../state/globalState");
class ArtifactsManager {
    static init() {
        [this.screenshotsDir, this.htmlDir].forEach((dir) => {
            if (!fs_1.default.existsSync(dir))
                fs_1.default.mkdirSync(dir, { recursive: true });
        });
    }
    static async saveScreenshot(page, cycle, step) {
        const filename = `cycle-${cycle}-${step}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        const filepath = path_1.default.join(this.screenshotsDir, filename);
        try {
            await page.screenshot({ path: filepath, fullPage: true });
            globalState_1.globalState.addLog('warn', `📸 Screenshot: ${filename}`, cycle);
            return filename;
        }
        catch (e) {
            globalState_1.globalState.addLog('error', `❌ Falha screenshot: ${e}`, cycle);
            return '';
        }
    }
    static async saveHTML(page, cycle, step) {
        const filename = `cycle-${cycle}-${step}-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
        const filepath = path_1.default.join(this.htmlDir, filename);
        try {
            const html = await page.content();
            fs_1.default.writeFileSync(filepath, html, 'utf8');
            globalState_1.globalState.addLog('warn', `🌐 HTML salvo: ${filename}`, cycle);
            return filename;
        }
        catch (e) {
            globalState_1.globalState.addLog('error', `❌ Falha HTML: ${e}`, cycle);
            return '';
        }
    }
    /** Salva screenshot + HTML de erro para um ciclo — atalho usado no catch do mockFlow */
    static async saveErrorArtifacts(page, cycle) {
        ArtifactsManager.init();
        await ArtifactsManager.saveScreenshot(page, cycle, 'error');
        await ArtifactsManager.saveHTML(page, cycle, 'error');
    }
}
exports.ArtifactsManager = ArtifactsManager;
ArtifactsManager.screenshotsDir = path_1.default.join(process.cwd(), 'artifacts/screenshots');
ArtifactsManager.htmlDir = path_1.default.join(process.cwd(), 'artifacts/html');
//# sourceMappingURL=artifacts.js.map