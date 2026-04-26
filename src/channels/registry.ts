import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/**
 * Invoke a channel's sendAudio if implemented, otherwise throw.
 * Centralises the "audio not supported" error so each channel doesn't need
 * its own stub.
 */
export async function sendAudioViaChannel(
  channel: Channel,
  jid: string,
  filePath: string,
  caption?: string,
): Promise<void> {
  if (!channel.sendAudio) {
    throw new Error(`Audio not supported by channel "${channel.name}"`);
  }
  await channel.sendAudio(jid, filePath, caption);
}
