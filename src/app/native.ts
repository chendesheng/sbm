export declare function nativeRun(check: boolean): number;
export declare function nativeRender(status: number, version: string, busy: boolean, switchOn: boolean, canStart: boolean, canUpgrade: boolean, upgradeLabel: string, switchRevision: number): void;
export declare function nativeRenderVps(mode: string, exitLabel: string, exitAvailable: boolean, wpsEnabled: boolean, wpsLabel: string, wpsAvailable: boolean, wpsRevision: number): void;
export declare function nativeAction(): number;
export declare function nativeAuthorize(action: number, preparedDirectory: string): void;
export declare function nativeAuthorizationResult(report: (code: number, message: string) => void): void;
export declare function nativeAlert(message: string, error: boolean): void;
export declare function nativeClosing(): boolean;
export declare function nativeMainThread(): boolean;
