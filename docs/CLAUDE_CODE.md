# Running Claude Code on the ARM64 runtime

This documents how to run Anthropic's Claude Code CLI inside the `ios-linuxkit`
ARM64 guest, and the runtime fix that made it work.

## TL;DR

- Use **`@anthropic-ai/claude-code@2.1.112`** (installed with `npm`, run with
  Node). This is the **last version that ships a pure-JavaScript `cli.js`**.
- From `2.1.113` onward the npm package ships a ~245 MB **Bun-compiled native
  binary** (`bin/claude.exe`); the `claude` entry point just `spawn`s it. That
  binary hits the Bun allocator/JS-engine issues tracked in
  `.pi/skills/ish-arm64-bun-gdb`, so prefer the Node path until those are fully
  resolved.
- A glibc guest (Debian/Ubuntu) additionally needs the `clone3` fix in
  `kernel/fork.c` (see below). musl/Alpine guests were never affected.

## The blocker: glibc `clone3` thread creation

Node's libuv thread pool is created at process startup. On a glibc guest, that
goes through `clone3(2)`. `glibc`'s `clone3`-based `pthread_create` sets
`clone_args.pidfd = &pd->tid` **unconditionally**, without requesting
`CLONE_PIDFD`. The Linux kernel only treats that field as a meaningful output
pointer when `CLONE_PIDFD` is set and otherwise ignores it.

`sys_clone3` used to reject any non-zero `pidfd` with `EINVAL`. Because glibc
only falls back to the legacy `clone()` path on `ENOSYS` (not `EINVAL`), this
turned every glibc thread creation into a hard failure:

```
node[2]: ... WorkerThreadsTaskRunner::DelayedTaskScheduler::Start()
Assertion failed: (0) == (uv_thread_create(t.get(), start_thread, this))
```

The strace of a failing `node -e 1`:

```
clone3(<args>, 88) = -EINVAL      # flags=0x3d0f00 (standard pthread flags),
                                  # pidfd=child_tid=parent_tid=&pd->tid,
                                  # CLONE_PIDFD NOT set
```

The fix (in `kernel/fork.c`) ignores the `pidfd` field unless `CLONE_PIDFD` is
requested, matching kernel semantics:

```c
if (args.flags & CLONE_PIDFD_)        // we don't implement pidfd allocation
    return _EINVAL;
if (args.set_tid != 0 || args.set_tid_size != 0 || args.cgroup != 0)
    return _EINVAL;
```

musl (Alpine) was unaffected because it uses the legacy `clone()` syscall for
threads, which is why the existing Alpine lanes never surfaced this.

## `--jitless` and WebAssembly

Node is launched with `--jitless` (see the V8 flag injection in
`kernel/exec.c`), which disables WebAssembly. Claude Code's HTTP stack (undici)
compiles the `llhttp` parser as WASM and crashes with
`ReferenceError: WebAssembly is not defined`.

`kernel/exec.c` already auto-injects `--require=/lib/wasm-polyfill.js` (and
`/lib/fetch-polyfill.js`) **when those files exist in the guest**. Ship them
from `app/RootfsPatch.bundle/files/lib/` into the guest's `/lib`. With the WASM
polyfill present, undici works without real WebAssembly.

## Building the guest rootfs

```sh
# Host rootfs (glibc): drop a Node tarball into /opt and symlink into PATH
#   /opt/node/bin/{node,npm,npx} -> /usr/local/bin
# Trust your egress CA so npm can reach the registry:
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

npm install -g @anthropic-ai/claude-code@2.1.112

# Ship the Node polyfills the --jitless path needs:
cp app/RootfsPatch.bundle/files/lib/wasm-polyfill.js \
   app/RootfsPatch.bundle/files/lib/fetch-polyfill.js  /lib/

# Convert to a fakefs:
build-arm64-linux/tools/fakefsify rootfs.tar guest-arm64-fakefs
```

## Running

```sh
build-arm64-linux/ish -f guest-arm64-fakefs /bin/sh -c '
  export PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
  export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
  claude --version
'
# -> 2.1.112 (Claude Code)
```

`claude --version` and `claude --help` both succeed; the `#!/usr/bin/env node`
shebang entry point resolves correctly.

## Validation note

The fix was found and validated on an x86_64 host by running the AArch64 `ish`
binary under `qemu-user-static` (binfmt). That is double emulation
(qemu → ish → interpreted guest), so it is ~50-100x slower than the native
AArch64 target — `claude --version` takes minutes there but seconds on real
hardware. The `clone3` bug itself is host-independent and reproduces on a native
AArch64 glibc guest.

> When registering the AArch64 binfmt handler for this workflow, mask out the
> ELF `EI_OSABI` byte (offset 7): official Node binaries are marked
> `ELFOSABI_GNU` (3), not `SYSV` (0), so a too-strict magic/mask will refuse to
> run them.
