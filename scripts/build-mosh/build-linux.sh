#!/usr/bin/env bash
# Build a static, glibc-only mosh-client binary inside manylinux2014.
#
# Inputs (env):
#   MOSH_REF  — git ref of mobile-shell/mosh to build (e.g. mosh-1.4.0)
#   ARCH      — x64 | arm64 (for output naming only; container is already that arch)
#   OUT_DIR   — directory to write mosh-client-linux-<arch> + sha256
#
# Output:
#   $OUT_DIR/mosh-client-linux-<arch>
#   $OUT_DIR/mosh-client-linux-<arch>.sha256
#
# Strategy: build OpenSSL, protobuf, ncurses as static archives in a
# scratch prefix, then build mosh against those, link libstdc++/libgcc
# statically. The resulting binary depends only on the glibc runtime
# (manylinux2014 = glibc 2.17 = compatible with virtually every distro
# released since 2014, including Debian 9+, Ubuntu 18.04+, CentOS 7+).
set -euo pipefail

: "${MOSH_REF:?missing MOSH_REF}"
: "${ARCH:?missing ARCH}"
: "${OUT_DIR:?missing OUT_DIR}"

OPENSSL_VER=3.0.13
PROTOBUF_VER=21.12
NCURSES_VER=6.4

WORK=$(mktemp -d)
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX/lib" "$PREFIX/include" "$OUT_DIR"

yum install -y -q autoconf automake libtool perl perl-IPC-Cmd make gcc gcc-c++ pkgconfig zlib-devel

cd "$WORK"

# OpenSSL static
curl -fsSL "https://www.openssl.org/source/openssl-$OPENSSL_VER.tar.gz" | tar xz
( cd "openssl-$OPENSSL_VER"
  ./config no-shared no-tests --prefix="$PREFIX" --openssldir="$PREFIX/ssl"
  make -j"$(nproc)"
  make install_sw )

# protobuf static (3.x stays compatible with mosh's generated proto code)
curl -fsSL "https://github.com/protocolbuffers/protobuf/releases/download/v$PROTOBUF_VER/protobuf-cpp-3.$PROTOBUF_VER.tar.gz" | tar xz
( cd "protobuf-3.$PROTOBUF_VER"
  ./configure --prefix="$PREFIX" --enable-static --disable-shared --with-pic
  make -j"$(nproc)"
  make install )

# ncurses static
curl -fsSL "https://invisible-island.net/archives/ncurses/ncurses-$NCURSES_VER.tar.gz" | tar xz
( cd "ncurses-$NCURSES_VER"
  ./configure --prefix="$PREFIX" --without-shared --without-debug --without-cxx-shared --without-tests --disable-pc-files --with-termlib --enable-widec
  make -j"$(nproc)"
  make install )

# Mosh
git clone --depth 1 --branch "$MOSH_REF" https://github.com/mobile-shell/mosh.git
( cd mosh
  ./autogen.sh
  PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/lib64/pkgconfig" \
  ./configure --enable-completion=no --disable-server \
    CXXFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw -O2" \
    CFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw -O2" \
    LDFLAGS="-L$PREFIX/lib -L$PREFIX/lib64 -static-libstdc++ -static-libgcc"
  make -j"$(nproc)" )

OUT_BIN="$OUT_DIR/mosh-client-linux-$ARCH"
cp mosh/src/frontend/mosh-client "$OUT_BIN"
strip "$OUT_BIN"

echo "--- file ---"
file "$OUT_BIN"
echo "--- ldd ---"
ldd "$OUT_BIN" || true
echo "--- size ---"
ls -lh "$OUT_BIN"

# Sanity check: must not link any non-system shared libraries.
if ldd "$OUT_BIN" | grep -E "libssl|libcrypto|libprotobuf|libncurses|libstdc\+\+" ; then
  echo "ERROR: mosh-client still links a non-system shared library; static linking failed." >&2
  exit 1
fi

( cd "$OUT_DIR" && sha256sum "mosh-client-linux-$ARCH" > "mosh-client-linux-$ARCH.sha256" )
cat "$OUT_DIR/mosh-client-linux-$ARCH.sha256"
