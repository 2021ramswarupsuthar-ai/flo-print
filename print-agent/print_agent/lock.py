import os
from contextlib import contextmanager


@contextmanager
def single_instance(root):
    (root / "state").mkdir(exist_ok=True)
    handle = (root / "state" / "instance.lock").open("a+b")
    handle.seek(0)
    handle.write(b"0")
    handle.flush()
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise RuntimeError("Another PrintBot process is running") from None
    try:
        yield
    finally:
        handle.close()
