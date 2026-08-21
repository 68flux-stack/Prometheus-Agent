export const WINDOWS_PLAN_MODE_ENV = "PROMETHEUS_WINDOWS_PLAN_MODE";
export const WINDOWS_WRITE_ROOTS_ENV = "PROMETHEUS_WINDOWS_WRITE_ROOTS";

// Windows has no `srt`, so workspace mode is enforced inside the kernel instead of
// by the OS: an audit hook rejects mutations that resolve outside the allowed roots.
// ponytail: in-process only. A subprocess the kernel starts is not covered — that
// is the documented Windows ceiling for workspace mode, lift it with a real sandbox.
export const WINDOWS_PLAN_POLICY_BOOTSTRAP_CODE = `
import os as _prometheus_plan_os
import sys as _prometheus_plan_sys

if not getattr(_prometheus_plan_sys, "_prometheus_plan_policy_installed", False):
    _PROMETHEUS_PLAN_MODE = _prometheus_plan_os.environ.get("${WINDOWS_PLAN_MODE_ENV}") == "1"
    _PROMETHEUS_WRITE_ROOTS_RAW = _prometheus_plan_os.environ.get("${WINDOWS_WRITE_ROOTS_ENV}", "")

    _PROMETHEUS_PLAN_MUTATION_EVENTS = frozenset({
        "os.remove", "os.rmdir", "os.mkdir", "os.truncate", "os.chmod", "os.utime",
        "os.rename", "os.replace", "os.link", "os.symlink",
        "shutil.copyfile", "shutil.copymode", "shutil.copystat",
        "winreg.CreateKey", "winreg.DeleteKey", "winreg.DeleteValue",
        "winreg.SaveKey", "winreg.SetValue", "winreg.SetValueEx",
    })

    # Which argument names the thing being written. Copies and links only create
    # their destination, so their source stays readable from anywhere.
    _PROMETHEUS_WRITE_PATH_ARGS = {
        "os.remove": (0,), "os.rmdir": (0,), "os.mkdir": (0,), "os.truncate": (0,),
        "os.chmod": (0,), "os.utime": (0,), "os.rename": (0, 1), "os.replace": (0, 1),
        "os.link": (1,), "os.symlink": (1,),
        "shutil.copyfile": (1,), "shutil.copymode": (1,), "shutil.copystat": (1,),
    }

    def _prometheus_plan_is_write_open(args):
        mode = args[1] if len(args) > 1 else None
        flags = args[2] if len(args) > 2 else None
        if isinstance(mode, str):
            return any(character in mode for character in ("w", "a", "x", "+"))
        if isinstance(flags, int):
            return bool(
                flags
                & (
                    _prometheus_plan_os.O_WRONLY
                    | _prometheus_plan_os.O_RDWR
                    | _prometheus_plan_os.O_APPEND
                    | _prometheus_plan_os.O_CREAT
                    | _prometheus_plan_os.O_TRUNC
                )
            )
        return False

    if _PROMETHEUS_PLAN_MODE:
        _prometheus_plan_sys._prometheus_plan_policy_installed = True

        def _prometheus_plan_audit(event, args):
            blocked = event in _PROMETHEUS_PLAN_MUTATION_EVENTS
            if event == "open":
                blocked = _prometheus_plan_is_write_open(args)
            if blocked:
                raise PermissionError(
                    f"Plan mode blocks file edits and creation on Windows; blocked operation: {event}"
                )

        _prometheus_plan_sys.addaudithook(_prometheus_plan_audit)
    elif _PROMETHEUS_WRITE_ROOTS_RAW:
        _prometheus_plan_sys._prometheus_plan_policy_installed = True
        import json as _prometheus_plan_json
        import tempfile as _prometheus_plan_tempfile

        def _prometheus_plan_normalize(path):
            if isinstance(path, bytes):
                path = _prometheus_plan_os.fsdecode(path)
            elif not isinstance(path, str):
                path = _prometheus_plan_os.fspath(path)
            # realpath, not abspath: a junction or symlink out of the workspace
            # must not become a way around the roots.
            return _prometheus_plan_os.path.normcase(_prometheus_plan_os.path.realpath(path))

        _PROMETHEUS_WRITE_ROOTS = []
        for _prometheus_plan_root in [
            *_prometheus_plan_json.loads(_PROMETHEUS_WRITE_ROOTS_RAW),
            _prometheus_plan_tempfile.gettempdir(),
        ]:
            try:
                _PROMETHEUS_WRITE_ROOTS.append(_prometheus_plan_normalize(_prometheus_plan_root))
            except Exception:
                pass

        def _prometheus_plan_allowed(path):
            try:
                target = _prometheus_plan_normalize(path)
            except Exception:
                # An unresolvable target (an fd, a device) is not a workspace path.
                return False
            return any(
                target == root or target.startswith(root + _prometheus_plan_os.sep)
                for root in _PROMETHEUS_WRITE_ROOTS
            )

        async def request_directory_access(path, reason=""):
            """Ask the user to allow this directory for the rest of the conversation."""
            import rlm as _prometheus_rlm

            response = await _prometheus_rlm.host_request(
                "permission.request_directory", {"path": str(path), "reason": str(reason)}
            )
            if response.get("granted"):
                try:
                    _PROMETHEUS_WRITE_ROOTS.append(
                        _prometheus_plan_normalize(response.get("root") or path)
                    )
                except Exception:
                    pass
            return response.get("message", "")

        def _prometheus_plan_audit(event, args):
            if event == "open":
                indexes = (0,) if _prometheus_plan_is_write_open(args) else ()
            else:
                indexes = _PROMETHEUS_WRITE_PATH_ARGS.get(event, ())
            for index in indexes:
                if index >= len(args):
                    continue
                target = args[index]
                # File-descriptor forms carry no path; the descriptor itself came
                # from an open() this hook already cleared.
                if isinstance(target, int):
                    continue
                if not _prometheus_plan_allowed(target):
                    raise PermissionError(
                        f"Workspace mode blocks writes outside the workspace: {target!r} ({event}). "
                        "If this write is needed, call request_directory_access(<directory>, <reason>) "
                        "to ask the user for access, then retry."
                    )

        _prometheus_plan_sys.addaudithook(_prometheus_plan_audit)
`.trim();
