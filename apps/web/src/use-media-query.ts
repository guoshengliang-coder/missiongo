import { useEffect, useState } from "react";

/**
 * A media query kept in React state, so a component can branch on the same
 * condition the stylesheet uses instead of guessing from the window width.
 *
 * The initial value is read during render, before any effect runs: a first paint
 * that assumed the non-matching branch would flash the wrong layout.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
