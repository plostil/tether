import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import { Card } from '../ui/card.ts';
import { Banner } from '../ui/toast.ts';
import type { Screen } from '../app.ts';

/** Stage 3 placeholder. Stage 5 replaces this with a live prerequisite
 *  checklist driven by the apps/ios-bridge process. */
export const IphoneSetupScreen: Screen = (root, ctx) => {
  root.replaceChildren(
    h('div', { class: 'col' },
      h('div', { class: 'eyebrow' }, 'Control an iPhone'),
      h('h1', {}, 'iPhone control setup'),
      Banner({ tone: 'info', message: 'Controlling an iPhone needs the local bridge (apps/ios-bridge) running over USB. Full setup and a live prerequisite checklist land with the bridge.' }),
      Card({ title: 'What it will do', children: [
        h('p', { class: 'muted' }, 'The bridge drives a dev-signed WebDriverAgent over USB via go-ios: it streams the phone screen and forwards taps, drags, and typing. See docs/IOS-CONTROL.md for the setup.'),
      ] }),
      h('div', {}, Button({ label: 'Back', variant: 'ghost', onClick: () => ctx.router.navigate('/') })),
    ),
  );
  return () => {};
};
