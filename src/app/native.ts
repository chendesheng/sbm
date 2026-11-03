export declare function nativeRun(check: boolean): number;
export declare function nativeRender(status: number, version: string, busy: boolean, loaded: boolean, canStart: boolean, canUpgrade: boolean, upgradeLabel: string): void;
export declare function nativeAction(): number;
export declare function nativeAuthorize(action: number, preparedDirectory: string): void;
export declare function nativeAuthorizationResult(report: (code: number, message: string) => void): void;
export declare function nativeAlert(message: string, error: boolean): void;
export declare function nativeClosing(): boolean;
export declare function nativeMainThread(): boolean;
