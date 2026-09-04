/** Hash router. Routes look like `#/pair/join?blob=…`. The legacy pairing
 *  fragment `#pair=<blob>` (older QR codes) is rewritten to `#/pair/join`. */

export interface Route {
  path: string; // e.g. "/pair/join"
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  let h = hash.replace(/^#/, '');
  // Legacy QR: #pair=<blob>  ->  /pair/join?blob=<blob>
  const legacy = h.match(/^pair=([A-Za-z0-9_-]+)/);
  if (legacy) h = `/pair/join?blob=${legacy[1]}`;
  if (!h.startsWith('/')) h = '/' + h;
  const [path, qs = ''] = h.split('?');
  return { path: path || '/', query: new URLSearchParams(qs) };
}

export interface Router {
  current(): Route;
  navigate(path: string): void;
  onChange(fn: (r: Route) => void): () => void;
}

export function createRouter(): Router {
  const listeners = new Set<(r: Route) => void>();
  const emit = () => {
    const r = parseHash(location.hash);
    for (const fn of listeners) fn(r);
  };
  window.addEventListener('hashchange', emit);
  return {
    current: () => parseHash(location.hash),
    navigate(path) {
      if (location.hash === '#' + path) emit();
      else location.hash = path;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
