"""Protect bot data for the current Windows operator and Local System."""

import os


def protect(root):
    if os.name != "nt":
        return
    import win32api
    import win32security
    import ntsecuritycon

    token = win32security.OpenProcessToken(
        win32api.GetCurrentProcess(), win32security.TOKEN_QUERY
    )
    try:
        sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()
    system = win32security.CreateWellKnownSid(win32security.WinLocalSystemSid, None)
    acl = win32security.ACL()
    flags = win32security.OBJECT_INHERIT_ACE | win32security.CONTAINER_INHERIT_ACE
    for identity in (sid, system):
        acl.AddAccessAllowedAceEx(
            win32security.ACL_REVISION, flags, ntsecuritycon.FILE_ALL_ACCESS, identity
        )
    for name in ("state", "downloads", "processing", "temp", "logs"):
        path = root / name
        path.mkdir(exist_ok=True)
        win32security.SetNamedSecurityInfo(
            str(path),
            win32security.SE_FILE_OBJECT,
            win32security.DACL_SECURITY_INFORMATION
            | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            acl,
            None,
        )
