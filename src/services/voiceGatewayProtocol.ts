export interface VoiceGatewayIdentifyData {
  channel_id: bigint
  token: string
  max_dave_protocol_version: 0 | 1
  supports_encoded_transforms: boolean
  dave_supported: boolean
}

// BigInt values must stay unquoted because the Go SFU decodes them as int64.
export function stringifyVoiceGatewayPacket(data: unknown): string {
  return JSON.stringify(data, (_, v) =>
    typeof v === 'bigint' ? `__BI__${v}` : v
  ).replace(/"__BI__(\d+)"/g, '$1')
}

export function buildVoiceGatewayIdentifyData(
  channelId: string | bigint,
  token: string,
  daveCapable: boolean,
): VoiceGatewayIdentifyData {
  return {
    channel_id: typeof channelId === 'bigint' ? channelId : BigInt(channelId),
    token,
    max_dave_protocol_version: daveCapable ? 1 : 0,
    supports_encoded_transforms: daveCapable,
    dave_supported: daveCapable,
  }
}
