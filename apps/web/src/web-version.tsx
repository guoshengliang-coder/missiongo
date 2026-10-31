declare const MISSIONGO_WEB_VERSION: string;

/** Bundled with the running page: cached clients must keep their own version. */
export function WebVersion() {
  return <small className="web-version" aria-label="Web version">Web v{MISSIONGO_WEB_VERSION}</small>;
}
