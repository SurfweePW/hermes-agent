package com.hermes.companion;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.net.SocketTimeoutException;

/** A slow peer cannot extend the total read deadline by trickling bytes. */
final class OwnerDeadlineInput extends FilterInputStream {
    private final Socket socket;
    private final long deadline;
    OwnerDeadlineInput(InputStream input, Socket socket, long deadline) {
        super(input); this.socket = socket; this.deadline = deadline;
    }
    private void check() throws IOException {
        long remaining = (deadline - System.nanoTime()) / 1_000_000L;
        if (remaining <= 0) throw new SocketTimeoutException();
        socket.setSoTimeout((int) Math.min(remaining, 15000));
    }
    @Override public int read() throws IOException { check(); return in.read(); }
    @Override public int read(byte[] b, int off, int len) throws IOException { check(); return in.read(b, off, len); }
}
