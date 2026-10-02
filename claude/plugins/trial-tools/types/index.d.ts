export type TpsState =
  | { phase: "working"; turnId: string }
  | { phase: "unavailable" }
  | { phase: "complete"; outputTokens: number; durationMs: number; interrupted: boolean };

declare module "claude-code" {
  interface PluginState {
    "trial-tools": { tps: TpsState };
  }
}
