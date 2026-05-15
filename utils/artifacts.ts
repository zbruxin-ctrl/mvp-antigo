import fs from 'fs';
import path from 'path';
import { globalState } from '../state/globalState';

// Tipo compatível com page.screenshot() do Playwright, que retorna Promise<Buffer>
type PageLike = {
  screenshot: (o: { path: string; fullPage: boolean }) => Promise<Buffer | void>;
  content: () => Promise<string>;
};

export class ArtifactsManager {
  static screenshotsDir = path.join(process.cwd(), 'artifacts/screenshots');
  static htmlDir = path.join(process.cwd(), 'artifacts/html');

  static init(): void {
    [this.screenshotsDir, this.htmlDir].forEach((dir) => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }

  static async saveScreenshot(
    page: PageLike,
    cycle: number,
    step: string
  ): Promise<string> {
    const filename = `cycle-${cycle}-${step}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const filepath = path.join(this.screenshotsDir, filename);
    try {
      await page.screenshot({ path: filepath, fullPage: true });
      globalState.addLog('warn', `📸 Screenshot: ${filename}`, cycle);
      return filename;
    } catch (e) {
      globalState.addLog('error', `❌ Falha screenshot: ${e}`, cycle);
      return '';
    }
  }

  static async saveHTML(
    page: PageLike,
    cycle: number,
    step: string
  ): Promise<string> {
    const filename = `cycle-${cycle}-${step}-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
    const filepath = path.join(this.htmlDir, filename);
    try {
      const html = await page.content();
      fs.writeFileSync(filepath, html, 'utf8');
      globalState.addLog('warn', `🌐 HTML salvo: ${filename}`, cycle);
      return filename;
    } catch (e) {
      globalState.addLog('error', `❌ Falha HTML: ${e}`, cycle);
      return '';
    }
  }

  /** Salva screenshot + HTML de erro para um ciclo — atalho usado no catch do mockFlow */
  static async saveErrorArtifacts(page: PageLike, cycle: number): Promise<void> {
    ArtifactsManager.init();
    await ArtifactsManager.saveScreenshot(page, cycle, 'error');
    await ArtifactsManager.saveHTML(page, cycle, 'error');
  }
}
