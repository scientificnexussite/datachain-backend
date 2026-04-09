import { createLibp2p } from 'libp2p';
import chalk from 'chalk';

// Wildcard imports to dynamically resolve exports and bypass ESM strict named-export errors
import * as tcpPkg from '@libp2p/tcp';
const tcp = tcpPkg.tcp || tcpPkg.default || tcpPkg;

import * as mplexPkg from '@libp2p/mplex';
const mplex = mplexPkg.mplex || mplexPkg.default || mplexPkg;

import * as noisePkg from '@libp2p/noise';
const noise = noisePkg.noise || noisePkg.default || noisePkg;

import * as mdnsPkg from '@libp2p/mdns';
const mdns = mdnsPkg.mdns || mdnsPkg.multicastDNS || mdnsPkg.default || mdnsPkg;

const createNode = async () => {
  try {
      const node = await createLibp2p({
        addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
        transports: [tcp()],
        streamMuxers: [mplex()],
        connectionEncryption: [noise()],
        peerDiscovery: [ mdns({ interval: 1000 }) ]
      });

      await node.start();
      
      console.log(chalk.cyan('--- P2P NETWORK NODE INITIATED ---'));
      console.log(chalk.white(`Node ID: ${node.peerId.toString()}`));
      
      node.addEventListener('peer:discovery', (evt) => {
        console.log(chalk.yellow(`[DISCOVERY] Potential Peer Found: ${evt.detail.id.toString()}`));
      });

      node.addEventListener('peer:connect', (evt) => {
        console.log(chalk.green(`[CONNECTION] Handshake Established with: ${evt.detail.remotePeer.toString()}`));
      });

      return node;
  } catch (error) {
      console.error(chalk.red('[P2P ERROR] Failed to initialize node:'), error);
  }
};

createNode();
