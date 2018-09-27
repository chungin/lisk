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

const childProcess = require('child_process');
const utils = require('./utils');
const shell = require('./setup/shell');
const config = require('./setup/config');
const waitUntilBlockchainReady = require('../common/utils/wait_for')
	.blockchainReady;

const NODE_FINISHED_SYNC_REGEX = /Finished sync/;
const NODE_FINISHED_SYNC_TIMEOUT = 40000;
const PM2_MAX_LOG_LINES = 10000;
const WAIT_BEFORE_CONNECT_MS = 20000;

const getPeersStatus = peers => {
	return Promise.all(
		peers.map(peer => {
			return utils.http.getNodeStatus(peer.httpPort, peer.ip);
		})
	);
};

const getMaxAndAvgHeight = peerStatusList => {
	let maxHeight = 1;
	let heightSum = 0;
	const totalPeers = peerStatusList.length;
	peerStatusList.forEach(peerStatus => {
		if (peerStatus.height > maxHeight) {
			maxHeight = peerStatus.height;
		}
		heightSum += peerStatus.height;
	});

	return {
		maxHeight,
		averageHeight: heightSum / totalPeers,
	};
};

class Network {
	constructor(configurations) {
		this.configurations = configurations;
		this.sockets = [];
		this.pm2ConfigMap = {};
	}

	establishMonitoringSocketsConnections() {
		return new Promise((resolve, reject) => {
			utils.ws.establishWSConnectionsToNodes(
				this.configurations,
				(err, socketsResult) => {
					if (err) {
						return reject(
							new Error(
								`Failed to establish monitoring connections due to error: ${
									err.message
								}`
							)
						);
					}
					this.sockets = socketsResult;
					resolve(socketsResult);
				}
			);
		});
	}

	killMonitoringSocketsConnections() {
		return new Promise((resolve, reject) => {
			utils.ws.killMonitoringSockets(this.sockets, err => {
				if (err) {
					return reject(err);
				}
				resolve();
			});
		});
	}

	// TODO 2: Rename to launchNetwork or just launch
	createNetwork() {
		return Promise.resolve()
			.then(() => {
				return this.generatePM2Configs()
				.then(pm2Configs => {
					this.pm2ConfigMap = {};
					pm2Configs.apps.forEach(pm2Config => {
						this.pm2ConfigMap[pm2Config.name] = pm2Config;
					});
				});
			})
			.then(() => {
				return this.recreateDatabases();
			})
			.then(() => {
				return this.clearAllLogs();
			})
			.then(() => {
				return this.launchTestNodes();
			})
			.then(() => {
				return this.waitForAllNodesToBeReady();
			})
			.then(() => {
				return this.enableForgingForDelegates();
			})
			.then(() => {
				return this.establishMonitoringSocketsConnections();
			})
			.then(() => {
				return new Promise((resolve, reject) => {
					utils.logger.log(
						`Waiting ${WAIT_BEFORE_CONNECT_MS /
							1000} seconds for nodes to establish connections`
					);
					setTimeout(err => {
						if (err) {
							return reject(err);
						}
						resolve();
					}, WAIT_BEFORE_CONNECT_MS);
				});
			});
	}

	generatePM2Configs() {
		return new Promise((resolve, reject) => {
			utils.logger.log('Generating PM2 configuration');
			config.generatePM2Configs(this.configurations, (err, pm2Configs) => {
				if (err) {
					return reject(err);
				}
				resolve(pm2Configs);
			});
		});
	}

	recreateDatabases() {
		return new Promise((resolve, reject) => {
			utils.logger.log('Recreating databases');
			shell.recreateDatabases(this.configurations, err => {
				if (err) {
					return reject(
						new Error(`Failed to recreate databases due to error ${
							err.message
						}`)
					);
				}
				resolve();
			});
		});
	}

	clearAllLogs() {
		return new Promise((resolve, reject) => {
			utils.logger.log('Clearing existing logs');
			shell.clearLogs(err => {
				if (err) {
					return reject(
						new Error(`Failed to clear all logs due to error ${
							err.message
						}`)
					);
				}
				resolve();
			});
		});
	}

	launchTestNodes() {
		return new Promise((resolve, reject) => {
			utils.logger.log('Launching network');
			shell.launchTestNodes(err => {
				if (err) {
					return reject(
						new Error(`Failed to launch nest nodes due to error: ${
							err.message
						}`)
					);
				}
				resolve();
			});
		});
	}

	killNetwork() {
		return Promise.resolve()
			.then(() => {
				return new Promise((resolve, reject) => {
					utils.logger.log('Shutting down network');
					shell.killTestNodes(err => {
						if (err) {
							return reject(err);
						}
						resolve();
					});
				});
			})
			.then(() => {
				return this.killMonitoringSocketsConnections();
			});
	}

	waitForNodeToBeReady(nodeName) {
		const retries = 20;
		const timeout = 3000;
		const configuration = this.pm2ConfigMap[nodeName];
		if (!configuration) {
			return Promise.reject(
				new Error(`Could not find pm2Config for ${nodeName}`)
			);
		}

		return new Promise((resolve, reject) => {
			waitUntilBlockchainReady(
				(err) => {
					if (err) {
						return reject(
							new Error(`Failed to wait for node to be ready due to error ${
								err.message
							}`)
						);
					}
					resolve();
				},
				retries,
				timeout,
				`http://${configuration.ip}:${configuration.httpPort}`
			);
		});
	}

	waitForAllNodesToBeReady() {
		utils.logger.log('Waiting for nodes to load the blockchain');

		const retries = 20;
		const timeout = 3000;

		const nodeReadyPromises = Object.keys(this.pm2ConfigMap).map(nodeName => {
			return this.waitForNodeToBeReady(nodeName);
		});

		// return Promise.all(nodeReadyPromises); // TODO 2 this is correct, next line is wrong
		return Promise.all(nodeReadyPromises).then(() => {
			return new Promise(resolve => {
				setTimeout(() => {
					resolve();
				}, 4000);
			});
		});
	}

	waitForNodesToBeReady(nodeNames) {
		utils.logger.log('Waiting for nodes to load the blockchain');

		const retries = 20;
		const timeout = 3000;

		const nodeReadyPromises = nodeNames.map(nodeName => {
			const pm2Config = this.pm2ConfigMap[nodeName] || {};
			return this.waitForNodeToBeReady(pm2Config.name);
		});

		return Promise.all(nodeReadyPromises);
	}

	enableForgingForDelegates() {
		utils.logger.log('Enabling forging with registered delegates');

		const enableForgingPromises = [];
		this.configurations.forEach(configuration => {
			configuration.forging.delegates.map(keys => {
				if (!configuration.forging.force) {
					const enableForgingPromise = utils.http.enableForging(
						keys,
						configuration.httpPort
					);
					enableForgingPromises.push(enableForgingPromise);
				}
			});
		});
		return Promise.all(enableForgingPromises)
			.then(forgingResults => {
				const someFailures = forgingResults.some(forgingResult => {
					return !forgingResult.forging;
				});
				if (someFailures) {
					throw new Error('Enabling forging failed for some of delegates');
				}
			})
			.catch(err => {
				// Rethrow error as higher level error.
				throw new Error(`Failed to enable forging for delegates due to error: ${
					err.message
				}`);
			});
	}

  getAllPeersLists() {
    return Promise.all(
      this.sockets.map(socket => {
        if (socket.state === 'open') {
          return socket.call('list', {});
        }
        return null;
      })
      .filter(result => {
        return result !== null;
      })
    ).then(result => {
			return result;
		});
	}

	getAllPeers() {
		return this.getAllPeersLists()
		.then(peerListResults => {
			const peersMap = {};
			peerListResults.forEach(result => {
				if (result.peers) {
					result.peers.forEach(peer => {
						peersMap[`${peer.ip}:${peer.wsPort}`] = peer;
					});
				}
			});
			return Object.keys(peersMap).map(peerString => {
				return peersMap[peerString];
			});
		});
	}

	// TODO 222: DELETE
	waitForNodeToSync(nodeName) {
		return new Promise((resolve, reject) => {
			const pm2LogProcess = childProcess.spawn('node_modules/.bin/pm2', [
				'logs',
				'--lines',
				PM2_MAX_LOG_LINES,
				nodeName,
			]);

			const nodeReadyTimeout = setTimeout(() => {
				pm2LogProcess.stdout.removeAllListeners('data');
				pm2LogProcess.removeAllListeners('error');
				reject(new Error(`Node ${nodeName} failed to sync before timeout`));
			}, NODE_FINISHED_SYNC_TIMEOUT);

			pm2LogProcess.once('error', err => {
				clearTimeout(nodeReadyTimeout);
				pm2LogProcess.stdout.removeAllListeners('data');
				reject(new Error(`Node ${nodeName} failed to sync: ${err.message}`));
			});
			pm2LogProcess.stdout.on('data', data => {
				const dataString = data.toString();
				// Make sure that all nodes have fully synced before we
				// run the test cases.
				if (NODE_FINISHED_SYNC_REGEX.test(dataString)) {
					clearTimeout(nodeReadyTimeout);
					pm2LogProcess.stdout.removeAllListeners('error');
					pm2LogProcess.stdout.removeAllListeners('data');
					resolve();
				}
			});
		});
	}

	// TODO 222: DELETE
	waitForAllNodesToSync(nodeNamesList) {
		const waitForSyncPromises = nodeNamesList.map(nodeName => {
			return this.waitForNodeToSync(nodeName);
		});
		return Promise.all(waitForSyncPromises);
	}

	clearLogs(nodeName) {
		return new Promise((resolve, reject) => {
			// TODO: Once we upgrade pm2 to a version which supports passing a nodeName
			// to the pm2 flush command, we should use that instead of removing the
			// log files manually. Currently pm2 flush clears the logs for all nodes.
			const sanitizedNodeName = nodeName.replace(/_/g, '-');
			childProcess.exec(`rm -rf test/network/logs/lisk-test-${sanitizedNodeName}.*`, err => {
				if (err) {
					return reject(
						new Error(`Failed to clear logs for node ${nodeName}: ${err.message}`)
					);
				}
				resolve();
			});
		});
	}

	stopNode(nodeName) {
		return new Promise((resolve, reject) => {
			childProcess.exec(`node_modules/.bin/pm2 stop ${nodeName}`, err => {
				if (err) {
					return reject(
						new Error(`Failed to stop node ${nodeName}: ${err.message}`)
					);
				}
				resolve();
			});
		});
	}

	startNode(nodeName, waitForSync) {
		let startPromise = new Promise((resolve, reject) => {
			childProcess.exec(`node_modules/.bin/pm2 start ${nodeName}`, err => {
				if (err) {
					return reject(
						new Error(`Failed to start node ${nodeName}: ${err.message}`)
					);
				}
				resolve();
			});
		});
		if (waitForSync) {
			startPromise = startPromise.then(() => {
				return this.waitForNodeToBeReady(nodeName).catch(err => {
					throw new Error(`Failed to start node ${nodeName} because it did not sync before timeout`);
				});
			});
		}
		return startPromise;
	}

	restartNode(nodeName, waitForSync) {
		return this.stopNode(nodeName)
			.then(() => {
				return this.startNode(nodeName, waitForSync);
			});
	}

	restartAllNodes(nodeNamesList, waitForSync) {
		const waitForRestartPromises = nodeNamesList.map(nodeName => {
			return this.restartNode(nodeName, waitForSync);
		});
		return Promise.all(waitForRestartPromises);
	}

	getNodesStatus() {
		return this.getAllPeers()
			.then(peers => {
				return getPeersStatus(peers);
			})
			.then(peerStatusList => {
				const peersCount = peerStatusList.length;
				const networkMaxAvgHeight = getMaxAndAvgHeight(peerStatusList);
				const status = {
					peersCount,
					peerStatusList,
					networkMaxAvgHeight,
				};
				return status;
			});
	}
}

module.exports = Network;
