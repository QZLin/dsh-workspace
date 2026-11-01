"""Package already-built standalone binaries, licenses, and checksums."""
from hashlib import sha256
from pathlib import Path
import json
import re
import zipfile

root = Path(__file__).resolve().parent.parent
metadata = json.loads((root / "package.json").read_text(encoding="utf-8"))
version = metadata["version"]
assert re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version)
dist = root / "dist"
for goos, arch in [("windows", "amd64"), ("windows", "arm64"), ("linux", "amd64"), ("linux", "arm64"), ("darwin", "amd64"), ("darwin", "arm64")]:
    source = dist / f"{goos}-{arch}"
    name = "dsh-workspace.exe" if goos == "windows" else "dsh-workspace"
    binary = (source / name).read_bytes()
    assert binary[:2] == b"MZ" if goos == "windows" else binary[:4] in (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf")
    filename = dist / f"dsh-workspace-cli-{version}-{goos}-{arch}.zip"
    if filename.exists():
        raise RuntimeError(f"Refuse to silently overwrite an existing release archive: {filename}")
    command = ".\\dsh-workspace.exe" if goos == "windows" else "./dsh-workspace"
    readme = f"""DSH workspace CLI {version} — {goos}/{arch}

此包是独立原生客户端，不需要 Go、Node 或 DSH CLI。
先在当前运行的 DSH profile 里安装/启用 dsh-workspace-ipc 插件。
解压此包后，在终端运行：
  {command} --help
  {command} ping
  {command} list --json
  {command} add <现存目录的绝对路径> --title <标题>
  {command} rename <id> <标题>
  {command} remove <id>
另支持 get、move、resolve、status、endpoint；--timeout 默认为5000毫秒。
业务路径原样交给服务端 registry 校验。客户端不启动额外 DSH profile，
不扫描其他 profile，不在写出请求后重连或重放。remove 只删注册，保留文件。
Unix 可先 chmod 0755 dsh-workspace，或安装到自己的 PATH 目录。
端点配置 --endpoint / --dshHome、DSH_HOME、DSH_WORKSPACE_PIPE (Windows)
或 DSH_WORKSPACE_SOCKET (Unix) 必须与当前 Host 一致。
退出码 0成功、1远端错误、2参数、3连接/IO、4超时、5协议错误。

分发时保留 LICENSE 与 THIRD_PARTY_NOTICES.md。
源码及完整协议说明在项目工作区 README.md / docs/protocol.md。
"""
    entries = {
        name: binary,
        "LICENSE": (source / "LICENSE").read_bytes(),
        "THIRD_PARTY_NOTICES.md": (source / "THIRD_PARTY_NOTICES.md").read_bytes(),
        "README.txt": readme.encode("utf-8"),
        "SHA256SUMS": f"{sha256(binary).hexdigest()}  {name}\n".encode("ascii"),
    }
    with zipfile.ZipFile(filename, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for entry, content in entries.items():
            info = zipfile.ZipInfo(entry, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = ((0o100755 if entry == name else 0o100644) << 16)
            archive.writestr(info, content)
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(entries)
    print(f"Pack {filename.name}: {filename.stat().st_size} bytes, verified CRC and licenses")
