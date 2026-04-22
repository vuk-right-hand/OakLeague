import 'server-only';
import Mux from '@mux/mux-node';

let _mux: Mux | null = null;

export function muxServer(): Mux {
  if (_mux) return _mux;
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    throw new Error('MUX_TOKEN_ID / MUX_TOKEN_SECRET not configured');
  }
  _mux = new Mux({ tokenId, tokenSecret });
  return _mux;
}
