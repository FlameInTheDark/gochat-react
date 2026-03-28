import { describe, expect, it } from 'vitest'
import { buildVoiceGatewayIdentifyData, stringifyVoiceGatewayPacket } from './voiceGatewayProtocol'

describe('voiceGatewayProtocol', () => {
  it('serializes DAVE-capable identify payload with all DAVE fields', () => {
    const packet = {
      op: 0,
      d: buildVoiceGatewayIdentifyData('2299153773295042560', 'token-123', true),
    }

    expect(stringifyVoiceGatewayPacket(packet)).toBe(
      '{"op":0,"d":{"channel_id":2299153773295042560,"token":"token-123","max_dave_protocol_version":1,"supports_encoded_transforms":true,"dave_supported":true}}',
    )
  })

  it('serializes non-DAVE identify payload explicitly', () => {
    const packet = {
      op: 0,
      d: buildVoiceGatewayIdentifyData(2299153773295042560n, 'token-123', false),
    }

    expect(stringifyVoiceGatewayPacket(packet)).toBe(
      '{"op":0,"d":{"channel_id":2299153773295042560,"token":"token-123","max_dave_protocol_version":0,"supports_encoded_transforms":false,"dave_supported":false}}',
    )
  })
})
