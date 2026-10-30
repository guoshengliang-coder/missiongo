import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsLeaveGuard } from "./settings-drafts";
import { DIALOG_HISTORY_MARKER, SIDEBAR_HISTORY_MARKER } from "./navigation";
import { SETTINGS_DEPTH, SETTINGS_INDEX, settingsRoute, settingsUrl, settingsExitUrl, type SettingsRoute } from "./settings-state";

const ROOT_INDEX = "missiongo:settings-root-index";
const ROOT_URL = "missiongo:settings-root-url";
/** The URL this entry was opened from, so going up can pop instead of pushing. */
const PARENT_URL = "missiongo:settings-parent-url";
/** Settings own their history entries, including cancellable Back and a direct return to the workspace. */
export function useSettingsNavigation() {
  const [route, setRoute] = useState(settingsRoute);
  const guard = useRef<SettingsLeaveGuard>(() => true);
  const snapshot = useRef({ url: window.location.href, state: history.state as Record<string, unknown> | null });
  const restoring = useRef(false);
  const approvedPop = useRef(false);
  const remember = () => { snapshot.current = { url: window.location.href, state: history.state }; };
  useEffect(() => {
    if (!settingsRoute() || history.state?.[SETTINGS_DEPTH]) return;
    const url = `${location.pathname}${location.search}${location.hash}`;
    const state = { ...history.state, [SETTINGS_INDEX]: 0 };
    history.replaceState(state, "", settingsExitUrl());
    history.pushState({ ...state, [SETTINGS_INDEX]: 1, [ROOT_INDEX]: 1, [ROOT_URL]: url, [SETTINGS_DEPTH]: 1 }, "", url);
    remember();
  }, []);
  const navigate = useCallback((next: SettingsRoute | null, saved = false): void => {
    const currentUrl = `${location.pathname}${location.search}${location.hash}`;
    const url = next ? settingsUrl(next) : settingsExitUrl();
    if (url === currentUrl || (!saved && !guard.current(() => navigate(next, true)))) return;
    const current = { ...(history.state as Record<string, unknown> | null) };
    const fromDrawer = Boolean(current[SIDEBAR_HISTORY_MARKER]);
    delete current[SIDEBAR_HISTORY_MARKER];
    delete current[DIALOG_HISTORY_MARKER];
    const index = Number(current[SETTINGS_INDEX]) || 0;
    const rootIndex = Number(current[ROOT_INDEX]) || 0;
    if (!next) {
      if (rootIndex > 0 && index >= rootIndex) {
        approvedPop.current = true; history.go(rootIndex - 1 - index); return;
      }
      delete current[SETTINGS_DEPTH]; delete current[ROOT_INDEX]; delete current[ROOT_URL]; delete current[PARENT_URL];
      history.replaceState(current, "", url); remember(); setRoute(null); return;
    }
    if (next.section === "index" && typeof current[ROOT_URL] === "string"
      && settingsRoute(new URL(current[ROOT_URL], location.origin))?.section === "index" && index > rootIndex) {
      approvedPop.current = true; history.go(rootIndex - index); return;
    }
    // Going up one level is a pop whenever the entry we came from is that level
    // (AND-316). Pushing instead left the system Back gesture pointing forward:
    // the phone walked back into the page the person had just left.
    if (current[PARENT_URL] === url && index > rootIndex) { approvedPop.current = true; history.back(); return; }
    const opening = settingsRoute() === null;
    const nextIndex = index + 1;
    const root = opening ? nextIndex : rootIndex || nextIndex;
    const state = { ...current, [SETTINGS_INDEX]: nextIndex, [ROOT_INDEX]: root,
      [ROOT_URL]: opening || !current[ROOT_URL] ? url : current[ROOT_URL], [SETTINGS_DEPTH]: nextIndex - root + 1,
      [PARENT_URL]: currentUrl };
    if (fromDrawer) history.replaceState(state, "", url);
    else {
      // Establish an indexed parent for a directly opened settings URL too.
      if (!opening && !rootIndex) history.replaceState({ ...current, [SETTINGS_INDEX]: index }, "", currentUrl);
      history.pushState(state, "", url);
    }
    remember(); setRoute(next);
  }, []);
  const syncFromPop = useCallback(() => {
    if (restoring.current) { restoring.current = false; remember(); return false; }
    const next = settingsRoute(); const previous = snapshot.current;
    const approved = approvedPop.current; approvedPop.current = false;
    if (!approved && settingsRoute(new URL(previous.url)) && previous.url !== location.href) {
      const oldIndex = Number(previous.state?.[SETTINGS_INDEX]) || 0;
      const nextIndex = Number(history.state?.[SETTINGS_INDEX]) || 0;
      if (!guard.current(() => { approvedPop.current = true; if (oldIndex !== nextIndex) history.go(nextIndex - oldIndex); else history.back(); })) {
        if (oldIndex !== nextIndex) { restoring.current = true; history.go(oldIndex - nextIndex); }
        else history.pushState(previous.state, "", previous.url);
        return false;
      }
    }
    remember(); setRoute(next); return true;
  }, []);
  return { route, navigate, syncFromPop, guard };
}
