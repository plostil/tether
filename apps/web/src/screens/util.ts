/** Screen helper: re-render a container whenever the store changes. */

import type { AppContext } from '../app/context.ts';

export function reactive(root: HTMLElement, ctx: AppContext, render: () => Node): () => void {
  const paint = () => root.replaceChildren(render());
  paint();
  return ctx.store.subscribe(paint);
}
