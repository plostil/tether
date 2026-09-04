/** Tiny hyperscript helper. No framework — just typed createElement. */

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (k === 'html') {
      node.innerHTML = String(v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c);
  }
  return node;
}

/** Replace all children of `el` with `nodes`. */
export function mount(el: Element, ...nodes: Child[]): void {
  el.replaceChildren(...nodes.filter((n): n is Node | string => n != null && n !== false));
}

export function clear(el: Element): void {
  el.replaceChildren();
}
