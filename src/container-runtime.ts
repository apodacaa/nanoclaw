/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Supports two runtimes:
 * - Apple Container (macOS): `container` CLI, bridge100 networking
 * - Docker (Linux/WSL/macOS Docker Desktop): `docker` CLI, host.docker.internal
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/**
 * The container runtime binary name.
 * Override with CONTAINER_RUNTIME env var. Defaults to 'container' on macOS
 * (Apple Container) and 'docker' everywhere else.
 */
export const CONTAINER_RUNTIME_BIN: 'container' | 'docker' =
  (process.env.CONTAINER_RUNTIME as 'container' | 'docker') ||
  (os.platform() === 'darwin' ? 'container' : 'docker');

const isAppleContainer = CONTAINER_RUNTIME_BIN === 'container';

/**
 * IP address containers use to reach the host machine.
 * Apple Container: detected from bridge100/bridge0 interface.
 * Docker: host.docker.internal (resolved via --add-host on Linux).
 */
export const CONTAINER_HOST_GATEWAY = isAppleContainer
  ? detectAppleHostGateway()
  : 'host.docker.internal';

function detectAppleHostGateway(): string {
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '192.168.64.1';
}

/**
 * Address the credential proxy binds to.
 * Apple Container: must be set via CREDENTIAL_PROXY_HOST in .env (bridge100
 *   only exists while containers run, but proxy starts before any container).
 * Docker Desktop (macOS/WSL): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to docker0 bridge IP so only containers can reach it.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (isAppleContainer) {
    logger.warn(
      'CREDENTIAL_PROXY_HOST is not set — Apple Container needs the bridge IP. Run /convert-to-apple-container to configure.',
    );
    return '192.168.64.1';
  }

  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux with Docker, host.docker.internal isn't built-in — add it explicitly
  if (!isAppleContainer && os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (!isAppleContainer) return; // Docker daemon managed separately
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        `║  1. Ensure ${isAppleContainer ? 'Apple Container' : 'Docker'} is installed${' '.repeat(isAppleContainer ? 16 : 23)}║`,
      );
      console.error(
        `║  2. Run: ${CONTAINER_RUNTIME_BIN} ${isAppleContainer ? 'system start' : 'info'}${' '.repeat(isAppleContainer ? 24 : 33)}║`,
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    if (isAppleContainer) {
      const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(output || '[]');
      const orphans = containers
        .filter(
          (c) =>
            c.status === 'running' &&
            c.configuration.id.startsWith('nanoclaw-'),
        )
        .map((c) => c.configuration.id);
      for (const name of orphans) {
        try {
          stopContainer(name);
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned containers',
        );
      }
    } else {
      const output = execSync(
        `${CONTAINER_RUNTIME_BIN} ps --filter "name=nanoclaw-" --format "{{.Names}}"`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      const orphans = output
        .trim()
        .split('\n')
        .filter((n) => n);
      for (const name of orphans) {
        try {
          stopContainer(name);
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned containers',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
