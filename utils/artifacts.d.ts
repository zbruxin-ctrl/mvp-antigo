type PageLike = {
    screenshot: (o: {
        path: string;
        fullPage: boolean;
    }) => Promise<Buffer | void>;
    content: () => Promise<string>;
};
export declare class ArtifactsManager {
    static screenshotsDir: string;
    static htmlDir: string;
    static init(): void;
    static saveScreenshot(page: PageLike, cycle: number, step: string): Promise<string>;
    static saveHTML(page: PageLike, cycle: number, step: string): Promise<string>;
    /** Salva screenshot + HTML de erro para um ciclo — atalho usado no catch do mockFlow */
    static saveErrorArtifacts(page: PageLike, cycle: number): Promise<void>;
}
export {};
//# sourceMappingURL=artifacts.d.ts.map