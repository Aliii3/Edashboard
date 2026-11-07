declare module '@commerce-os/domain' {
  export const Repo: any, Commands: Record<string, (...a: any[]) => any>, Actor: { current: string | null }, SCHEMA: Record<string, any>, SCHEMA_VERSION: number, Rule: new (m: string) => Error;
  export const DEFAULT_SETTINGS: any, TERMINAL_DELIVERY: Set<string>, ROLES: string[], DRIVER_SCOPE: Record<string, string>;
  export const canRun: (role: string, command: string) => boolean, migrate: (d: any) => any, integrity: () => { name: string; ok: boolean }[], carrierKey: (m: string, id: string) => string;
}
declare module '@commerce-os/domain/seed' { export const buildSeedWorkspace: () => any, runLoadTest: (n: number) => any; }
