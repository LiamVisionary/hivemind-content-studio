// The door to the Hivemind prompt library, as a `more`-menu row for a studio
// composer.
//
// It used to be a "Hive" button in the app's slim topbar, on every page — but
// the library's only effect is to WRITE A PROMPT into the studio on screen, so
// it belongs where that prompt is written rather than in chrome the hub and the
// settings pages had to carry too.
//
// The row opens the library and closes the menu it sits in, like Camera beside
// it. It used to be a toggle instead — press to show the panel, press again to
// hide it — which drew a check mark on a row that writes the prompt box, so it
// read as a setting rather than a door. The library dismisses itself now (its
// own trigger, Escape, a click outside, or writing the box).
import { setPromptLibraryOpen } from '../../app/promptLibraryStore.js';
import { isHivemindStudioEnabled } from '../../lib/hivemindStudio.js';
import { MenuItem } from '../../ui/Menu.jsx';

export function PromptLibraryItem({ close }) {
  // Studio mode only, exactly as the retired topbar button was: outside it there
  // is no Hivemind server to read templates and ingredients from.
  if (!isHivemindStudioEnabled()) return null;
  return (
    <MenuItem
      icon="logo"
      onClick={() => { setPromptLibraryOpen(true); close?.(); }}
      title="Saved templates and ingredients, inserted into the prompt box"
    >
      Hivemind prompt library
    </MenuItem>
  );
}
