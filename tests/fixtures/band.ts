/**
 * The status bar's site (`AbovePrompt`) props, as a test mounts them, on every supported engine.
 *
 * Claude Code 2.1.325 added `isCollapsed` (the person collapsed the band); 2.1.289, the minimum
 * engine, does not know it. One helper builds them for both: the result is cast, so the same test
 * source type-checks against either engine's declarations.
 */
export function bandProps(bodyColumns: number, over: Record<string, unknown> = {}): never {
  return { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 6 }, view: {}, ...over } as never
}
