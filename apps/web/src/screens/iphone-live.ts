import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import type { Screen } from '../app.ts';

/** Stage 3 placeholder; Stage 5 renders the MJPEG stream + control surface. */
export const IphoneLiveScreen: Screen = (root, ctx) => {
  root.replaceChildren(
    h('div', { class: 'empty' },
      h('p', {}, 'The iPhone live view arrives with the bridge (Stage 5).'),
      Button({ label: 'Back to setup', variant: 'primary', onClick: () => ctx.router.navigate('/iphone/setup') }),
    ),
  );
  return () => {};
};
