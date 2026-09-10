"""Every path this package derives from its own location, pinned to a value.

The 2026-09-04 splits moved 14,516 lines into packages/media-gateway/gateway/
and 4,727 lines into hivemind_content_studio/api/ — each ONE DIRECTORY DEEPER.
Both moves were verbatim, and that is exactly what made this class of bug
invisible: the text of ``Path(__file__).resolve().parents[2]`` did not change,
its MEANING did. Two such bugs reached the owner's machine before anyone
noticed (the gateway's vault DB pointed at ``packages/``, the strength-hunt
composer at a ``bin/`` that does not exist).

A byte-for-byte diff of the moved code cannot catch this — byte-for-byte
identity is the thing that hides it. So the check has to be on the RESOLVED
VALUE, not on the text, and it has to be automatic: a test that enumerates the
anchors itself, so the next module that grows one is covered without anybody
remembering to come back here.

packages/media-gateway/test_routes.py::FileRelativePaths does the same job for
the gateway package.
"""

import ast
import unittest
from pathlib import Path

from hivemind_content_studio import config
from hivemind_content_studio.account_scope import AccountPaths


PACKAGE = Path(config.__file__).resolve().parent
REPO_ROOT = PACKAGE.parents[1]


def _anchored_expressions(source_file):
    """Yield (lineno, source, value) for each __file__-anchored path expression.

    Only expressions that evaluate to a path are returned; a bare ``__file__``
    reference and anything needing names this module cannot supply are skipped.
    """
    text = source_file.read_text(encoding="utf-8", errors="replace")
    try:
        tree = ast.parse(text)
    except SyntaxError:  # pragma: no cover - a file we cannot parse is not ours to pin
        return

    def mentions_file(node):
        return any(isinstance(n, ast.Name) and n.id == "__file__" for n in ast.walk(node))

    found = []

    def walk(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.expr) and not isinstance(child, ast.Name) and mentions_file(child):
                found.append(child)
            else:
                walk(child)

    walk(tree)
    for node in found:
        namespace = {"__file__": str(source_file), "Path": Path}
        try:
            value = eval(compile(ast.Expression(node), "<anchor>", "eval"), namespace)
        except Exception:
            continue  # needs a name only the module itself has; not a bare path anchor
        if isinstance(value, Path):
            yield node.lineno, (ast.get_source_segment(text, node) or "").strip(), value


class FileAnchoredPaths(unittest.TestCase):
    """No module may derive a path that lands outside the tree it means."""

    def test_the_repo_root_this_package_computes_is_the_repo_root(self):
        # config.PROJECT_ROOT is what app_dirs() and load_config() are built on;
        # if it slips a level, ALL state moves.
        self.assertEqual(config.PROJECT_ROOT, REPO_ROOT)
        self.assertTrue((config.PROJECT_ROOT / "src" / "hivemind_content_studio").is_dir())
        self.assertTrue((config.PROJECT_ROOT / "packages" / "media-gateway").is_dir())
        self.assertNotEqual(
            config.PROJECT_ROOT.name, "src", "PROJECT_ROOT lost a directory level"
        )

    def test_every_file_anchored_path_in_the_package_resolves_inside_the_repo(self):
        strays = []
        for source in sorted(PACKAGE.rglob("*.py")):
            if "__pycache__" in source.parts:
                continue
            for lineno, text, value in _anchored_expressions(source):
                if REPO_ROOT not in value.parents and value != REPO_ROOT:
                    rel = source.relative_to(REPO_ROOT)
                    strays.append(f"{rel}:{lineno} {text} -> {value}")
        self.assertEqual(
            strays, [], "these __file__ anchors point outside the repo:\n" + "\n".join(strays)
        )

    def test_every_file_anchored_path_that_names_a_target_exists(self):
        """An anchor with a trailing name is pointing AT something. It must be there.

        A bare directory anchor (``parents[2]``) is exempt: it is a base other
        code appends to, and may legitimately name a directory only created at
        runtime. An anchor that spells out ``/ "scripts" / "x"`` is a claim.
        """
        missing = []
        for source in sorted(PACKAGE.rglob("*.py")):
            if "__pycache__" in source.parts:
                continue
            for lineno, text, value in _anchored_expressions(source):
                if "/" not in text and "joinpath" not in text:
                    continue  # a bare parents[N]/parent base, nothing claimed
                if not value.exists():
                    rel = source.relative_to(REPO_ROOT)
                    missing.append(f"{rel}:{lineno} {text} -> {value}")
        self.assertEqual(
            missing, [], "these __file__ anchors name something that is not there:\n" + "\n".join(missing)
        )


class ContextPaths(unittest.TestCase):
    """The three code-relative paths the control app hands every route."""

    def _resolve(self):
        """Read the anchor OUT of api/context.py and evaluate it.

        Deliberately not a re-implementation: hardcoding ``parents[3]`` here
        would pass no matter what context.py actually says, which is the exact
        failure mode this file exists to prevent. The value under test is the
        one that file computes.
        """
        from hivemind_content_studio.api import context

        source = Path(context.__file__).resolve()
        anchors = [
            value
            for _, text, value in _anchored_expressions(source)
            if "parents[" in text or text.endswith(".parent")
        ]
        self.assertEqual(
            len(anchors), 1, f"api/context.py grew a second path anchor: {anchors}"
        )
        return anchors[0]

    def test_the_repository_root_the_context_computes_is_the_repo_root(self):
        # context.py sits one level deeper than control_api.py did, so this is
        # parents[3] where the pre-split line read parents[2].
        self.assertEqual(self._resolve(), REPO_ROOT)

    def test_the_frontend_dist_and_compositor_defaults_are_real_paths(self):
        root = self._resolve()
        self.assertTrue(
            (root / "packages" / "open-generative-ai").is_dir(),
            "open_gen_dist's parent is not where the frontend lives",
        )
        self.assertTrue(
            (root / "packages" / "media-gateway" / "bin" / "compose-ingredients-sheet.py").is_file(),
            "ingredients_sheet_compositor points at a script that is not there",
        )


class AccountWorkspaceLayout(unittest.TestCase):
    """Where one account's private state lives — pinned literally.

    Every one of these is a path the owner's existing data already sits at. A
    change here does not fail loudly; it silently serves an empty library.
    """

    def test_the_per_account_paths_are_exactly_these(self):
        paths = AccountPaths.under(Path("/STATE"), 2)
        self.assertEqual(str(paths.root), "/STATE/accounts/2")
        self.assertEqual(str(paths.vault_db), "/STATE/accounts/2/vault.sqlite3")
        self.assertEqual(str(paths.outputs_root), "/STATE/accounts/2/generated/media-studio")
        self.assertEqual(str(paths.canvas_history_db), "/STATE/accounts/2/canvas-history.sqlite3")
        self.assertEqual(str(paths.prompt_history_db), "/STATE/accounts/2/prompt-history.sqlite3")
        self.assertEqual(
            str(paths.references_root), "/STATE/accounts/2/uploads/media-studio-references"
        )


class DataDirResolution(unittest.TestCase):
    """app_dirs() decides where ALL state lives, and one branch MOVES it."""

    def test_a_checkout_keeps_its_state_beside_the_code(self):
        # The suite points CONTENT_STUDIO_DATA_DIR at a temp tree so tests never
        # touch real state; drop it here to see the branch a real boot takes.
        import os
        from unittest import mock

        overrides = ("CONTENT_STUDIO_DATA_DIR", "CONTENT_STUDIO_CACHE_DIR", "CONTENT_STUDIO_LOG_DIR")
        with mock.patch.dict(os.environ, {k: "" for k in overrides}, clear=False):
            for key in overrides:
                os.environ.pop(key, None)
            dirs = config.app_dirs()
        self.assertEqual(dirs.data_dir, REPO_ROOT / "data")
        self.assertEqual(dirs.config_dir, REPO_ROOT / "data" / "config")

    def test_a_checkout_never_reaches_the_migrating_branch(self):
        """_migrate_repo_data_dir renames <repo>/data away. It must not fire here.

        The guard is _is_checkout(): a tree with a .git is left alone. This
        pins that the owner's checkout takes the non-migrating branch, so a
        future edit to the condition fails here rather than on their disk.
        """
        self.assertTrue(config._is_checkout(REPO_ROOT), "the repo stopped looking like a checkout")
        self.assertTrue((REPO_ROOT / ".git").exists())

    def test_the_migration_refuses_a_destination_that_already_holds_state(self):
        """It skips rather than merges, so a second boot cannot clobber the first."""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            legacy = Path(tmp) / "legacy"
            (legacy / "inner").mkdir(parents=True)
            destination = Path(tmp) / "destination"
            destination.mkdir()
            (destination / "already-here").write_text("x", encoding="utf-8")

            config._migrate_repo_data_dir(legacy, destination)

            self.assertTrue(legacy.is_dir(), "the legacy tree was moved onto occupied state")
            self.assertTrue((destination / "already-here").is_file())

    def test_the_migration_is_a_no_op_when_there_is_nothing_to_move(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            legacy = Path(tmp) / "absent"
            destination = Path(tmp) / "destination"
            config._migrate_repo_data_dir(legacy, destination)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
