// The door to the Hivemind prompt library (the explore dock), as a `more`-menu
// item for a studio composer.
//
// It used to be a "Hive" button in the app's slim topbar, on every page — but
// the dock's only effect is to INSERT A PROMPT into the studio on screen
// (ExploreDock's own `insert` refuses on any page that registers no inserter),
// so it belongs where that prompt is written rather than in chrome the hub and
// the settings pages had to carry too. The panel itself is still rendered once
// by App; this is only its trigger.
//
// Unlike its neighbours in that menu it does NOT close the menu it sits in: it
// is a toggle, and the "More" door is not itself an explore trigger, so pressing
// it again to get back here would dismiss the dock on pointerdown. Left open,
// the item is the way out of the dock as well as the way in.
import { useEffect, useState } from 'react';

import { getExploreDock, subscribeExploreDock, toggleExploreDock } from '../../app/exploreDockStore.js';
import { isHivemindStudioEnabled } from '../../lib/hivemindStudio.js';
import { MenuItem } from '../../ui/Menu.jsx';

export function ExploreDockItem() {
  const [open, setOpen] = useState(getExploreDock);
  useEffect(() => subscribeExploreDock(setOpen), []);
  // Studio mode only, exactly as the retired topbar button was: outside it there
  // is no Hivemind server to read templates and ingredients from.
  if (!isHivemindStudioEnabled()) return null;
  return (
    <MenuItem
      // ExploreDock's outside-pointerdown dismissal exempts anything inside
      // `[data-explore-trigger]`; without it the dock would close on the very
      // click that opened it, since this item is outside the dock's own root.
      data-explore-trigger
      icon="logo"
      selected={open}
      onClick={toggleExploreDock}
      title="Saved templates and ingredients, inserted into the prompt box"
    >
      Hivemind prompt library
    </MenuItem>
  );
}
