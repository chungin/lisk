/*
 * Copyright © 2018 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 */

'use strict';

const utils = require('../../utils');

module.exports = function(configurations, network) {
	describe('@network : peers', () => {
		const params = {};

		describe('mutual connections', () => {
			let mutualPeers = [];
			before(() => {
				return network.getAllPeersLists().then((peers) => {
					mutualPeers = peers;
				});
			});

			it('should return a list of peers mutually interconnected', () => {
				return mutualPeers.forEach(mutualPeer => {
					expect(mutualPeer).to.have.property('success').to.be.true;
					expect(mutualPeer)
						.to.have.property('peers')
						.to.be.an('array');
					const peerPorts = mutualPeer.peers.map(peer => {
						return peer.wsPort;
					});
					const allPorts = configurations.map(configuration => {
						return configuration.wsPort;
					});
					expect(_.intersection(allPorts, peerPorts)).to.be.an('array').and.not
						.to.be.empty;
				});
			});

			it('should have all the required peer properties', () => {
				const peerProps = [
					'ip',
					'wsPort',
					'state',
					'os',
					'version',
					'broadhash',
					'httpPort',
					'height',
					'nonce',
				];
				return mutualPeers.forEach(mutualPeer => {
					mutualPeer.peers.every(peer => {
						// delete the not required properties from ws peer list call
						// to keep consistency with api/controllers/peers.js/getPeers
						delete peer.updated;
						delete peer.clock;
						expect(peer).to.have.all.keys(peerProps);
					});
				});
			});
		});

		describe('forging', () => {
			before(done => {
				// Expect some blocks to be forged after 30 seconds
				const timesToCheckNetworkStatus = 30;
				let timesNetworkStatusChecked = 0;
				const checkNetworkStatusInterval = 1000;

				const nodeNames = configurations.map((nodeConfig, index) => {
					return `node_${index}`;
				});

				network.waitForNodesToBeReady(nodeNames)
				.then(() => {
					const checkingInterval = setInterval(() => {
						// network.setMonitoringSocketsConnections(params, configurations); // TODO 2 delete
						network.getNodesStatus()
							.then(data => {
								const { networkMaxAvgHeight } = data;
								timesNetworkStatusChecked += 1;
								utils.logger.log(
									`network status: height - ${
										networkMaxAvgHeight.maxHeight
									}, average height - ${networkMaxAvgHeight.averageHeight}`
								);
								if (timesNetworkStatusChecked === timesToCheckNetworkStatus) {
									clearInterval(checkingInterval);
									return done(null, networkMaxAvgHeight);
								}
							})
							.catch(err => {
								clearInterval(checkingInterval);
								done(err);
							});
					}, checkNetworkStatusInterval);
				})
				.catch(done);
			});

			describe('network status after 30 seconds', () => {
				let getNodesStatusError;
				let networkHeight;
				let networkAverageHeight;
				let peersCount;
				let peerStatusList;

				before(done => {
					network.getNodesStatus()
						.then(data => {
							peersCount = data.peersCount;
							peerStatusList = data.peerStatusList;
							networkHeight = data.networkMaxAvgHeight.maxHeight;
							networkAverageHeight = data.networkMaxAvgHeight.averageHeight;
							done();
						})
						.catch(err => {
							getNodesStatusError = err;
							done();
						});
				});

				it('should have no error', () => {
					return expect(getNodesStatusError).not.to.exist;
				});

				it('should have height > 1', () => {
					return expect(networkHeight).to.be.above(1);
				});

				it('should have average height above 1', () => {
					return expect(networkAverageHeight).to.be.above(1);
				});

				it('should have valid values values matching specification', () => {
					return network.getAllPeersLists().then(results => {
						return results.map(peersList => {
							return peersList.peers.map(peer => {
								expect(peer.ip).to.not.empty;
								expect(peer.wsPort).to.be.gte(5000);
								expect(peer.wsPort).to.be.lt(5010);
								expect(peer.version).to.not.empty;
								expect(peer.nonce).to.not.empty;
							});
						});
					});
				});

				it('should have different peers heights propagated correctly on peers lists', () => {
					return network.getAllPeersLists().then(results => {
						expect(
							results.some(peersList => {
								return peersList.peers.some(peer => {
									return peer.height > 1;
								});
							})
						);
					});
				});

				describe('network height', () => {
					it('should have networkHeight > 1 for all peers', () => {
						expect(peerStatusList)
							.to.be.an('Array')
							.to.have.lengthOf(peersCount);
						return expect(
							peerStatusList.forEach(peer => {
								expect(peer.networkHeight).to.be.above(1);
							})
						);
					});

					it('should be same for all the peers', () => {
						const networkHeights = _.groupBy(peerStatusList, 'networkHeight');
						const heights = Object.keys(networkHeights);
						return expect(heights).to.have.lengthOf(1);
					});
				});
			});
		});
	});
};
