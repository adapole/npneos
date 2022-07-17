import express, { Application, Request, Response, NextFunction } from 'express';
import sha512 from 'js-sha512';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
	apiGetAccountAssets,
	apiGetTxnParams,
	apiSubmitTransactions,
	ChainType,
	testNetClientalgod,
	testNetClientindexer,
} from './algodfunct';
require('dotenv').config();
import WebSocket from 'ws';
import WalletConnect from '@walletconnect/client';
import { IInternalEvent } from '@walletconnect/types';
import algosdk, {
	OnApplicationComplete,
	Transaction,
	TransactionSigner,
} from 'algosdk';
import { IWalletTransaction, SignTxnParams } from './types';
import { formatJsonRpcRequest } from '@json-rpc-tools/utils';
import { create } from 'ipfs-http-client';
import { checkStatus, getAddress } from './circle';
import { createClient } from 'redis';
import axios from 'axios';
import FileType from 'file-type';
import got from 'got';
import sizeOf from 'image-size';
import { sha256 } from 'js-sha256';
const PORT = process.env.PORT || 3000;

const app: Application = express();
(BigInt.prototype as any).toJSON = function () {
	return this.toString();
};
app.use(express.json());
app.use(express.static(__dirname + '/'));

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server: server });
const ipfs = create({
	host: 'ipfs.infura.io',
	port: 5001,
	protocol: 'https',
});
//const portRedis = process.env.PORT_REDIS || '6379';
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', (err) => console.log('Redis Client Error', err));

const DEFAULT_EXPIRATION = 3600;
/**
 * Returns Uint8array of LogicSig from ipfs, throw error
 * @param ipfsPath hash string of ipfs path
 */
const borrowGetLogic = async (ipfsPath: string): Promise<Uint8Array> => {
	const chunks = [];
	for await (const chunk of ipfs.cat(ipfsPath)) {
		chunks.push(chunk);
	}
	//console.log(chunks);
	//setBorrowLogicSig(chunks[0]);
	return chunks[0];
};

const onConnect = async (payload: IInternalEvent) => {
	const { accounts } = payload.params[0];
	const address = accounts[0];

	console.log(`onConnect: ${address}`);
	getAccountAssets(address, ChainType.TestNet);
};

const onDisconnect = async () => {};

const onSessionUpdate = async (accounts: string[]) => {
	const address = accounts[0];
	//await this.setState({ accounts, address });
	console.log(`onSessionUpdate: ${address}`);
	//await this.getAccountAssets();
	getAccountAssets(address, ChainType.TestNet);
};

const getAccountAssets = async (address: string, chain: ChainType) => {
	try {
		// get account balances
		const assets = await apiGetAccountAssets(chain, address);
		//await this.setStateAsync({ fetching: false, address, assets });
		console.log(`getAccountAssets: ${assets}`);
	} catch (error) {
		console.error(error);
		//await this.setStateAsync({ fetching: false });
	}
};
async function walletConnectSigner(
	txns: Transaction[],
	connector: WalletConnect | null,
	address: string
) {
	if (!connector) {
		console.log('No connector found!');
		return txns.map((tx) => {
			return {
				txID: tx.txID(),
				blob: new Uint8Array(),
			};
		});
	}
	const txnsToSign = txns.map((txn) => {
		const encodedTxn = Buffer.from(
			algosdk.encodeUnsignedTransaction(txn)
		).toString('base64');
		if (algosdk.encodeAddress(txn.from.publicKey) !== address)
			return { txn: encodedTxn, signers: [] };
		return { txn: encodedTxn };
	});
	// sign transaction
	const requestParams: SignTxnParams = [txnsToSign];

	const request = formatJsonRpcRequest('algo_signTxn', requestParams);
	//console.log('Request param:', request);
	const result: string[] = await connector.sendCustomRequest(request);

	//console.log('Raw response:', result);
	return result.map((element, idx) => {
		return element
			? {
					txID: txns[idx].txID(),
					blob: new Uint8Array(Buffer.from(element, 'base64')),
			  }
			: {
					txID: txns[idx].txID(),
					blob: new Uint8Array(),
			  };
	});
}
function getSignerWC(
	connector: WalletConnect,
	address: string
): TransactionSigner {
	return async (txnGroup: Transaction[], indexesToSign: number[]) => {
		const txns = await Promise.resolve(
			walletConnectSigner(txnGroup, connector, address)
		);
		return txns.map((tx) => {
			return tx.blob;
		});
	};
}
async function getContractAPI(): Promise<algosdk.ABIContract> {
	//const resp = await fetch('/d4t.json');
	// Read in the local contract.json file
	const buff = fs.readFileSync('./d4t.json');
	//return new algosdk.ABIContract(await resp.json());
	return new algosdk.ABIContract(JSON.parse(buff.toString()));
}

async function wcborrow(
	connector: WalletConnect,
	address: string,
	xid: number,
	loanamt: number,
	collateralamt: number
) {
	const suggested = await apiGetTxnParams(ChainType.TestNet);
	const suggestedParams = await apiGetTxnParams(ChainType.TestNet);
	const contract = await getContractAPI();

	//console.log(contract);
	// Utility function to return an ABIMethod by its name
	function getMethodByName(name: string): algosdk.ABIMethod {
		const m = contract.methods.find((mt: algosdk.ABIMethod) => {
			return mt.name == name;
		});
		if (m === undefined) throw Error('Method undefined: ' + name);
		return m;
	}
	const signer = getSignerWC(connector, address);
	suggested.flatFee = true;
	suggested.fee = 4000;
	// We initialize the common parameters here, they'll be passed to all the transactions
	// since they happen to be the same
	const commonParams = {
		appID: contract.networks['default'].appID,
		sender: address,
		suggestedParams: suggested,
		//onComplete: OnApplicationComplete.NoOpOC,
		signer: signer,
	};
	const comp = new algosdk.AtomicTransactionComposer();
	//'QmNU1gEgZKnMAL9gEWdWXAmuaDguUFhbGYqLw4p1iCGrSc' //'QmRY9HMe2fb6HAJhywnTTYQamLxQV9qJbjVeK7Wa314TeR' 'QmdvvuGptFDAoB6Vf9eJcPeQTKi2MjA3AnEv47syNPz6CS'
	const borrowLogic = await borrowGetLogic(
		'QmXJWc7jeSJ7F2Cc4cm6SSYdMnAiCG4M4gfaiQXvDbdAbL' //'QmWFR6jSCaqfxjVK9S3PNNyyCh35kYx5sGgwi7eZAogpD9' //'QmciTBaxmKRF9fHjJP7q83f9nvBPf757ocbyEvTnrMttyM' //'QmdHj2MHo6Evzjif3RhVCoMV2RMqkxvcZqLP946cN77ZEN' //'QmfWfsjuay1tJXJsNNzhZqgTqSj3CtnMGtu7NK3bVtdh6k' //'QmPubkotHM9iArEoRfntSB6VwbYBLz19c1uxmTp4FYJzbk' //'QmaDABqWt3iKso3YjxRRBCj4HJqqeerAvrBeLTMTTz7VzY' //'QmbbDFKzSAbBpbmhn9b31msyMz6vnZ3ZvKW9ebBuUDCyK9' //'QmYoFqC84dd7K5nCu5XGyWGyqDwEs7Aho8j46wqeGRfuJq' //'QmaGYNdQaj2cygMxxDQqJie3vfAJzCa1VBstReKY1ZuYjK'
	);
	//console.log(borrowLogic);
	const borrowLogicSig = borrowLogic;
	const addressLogicSig =
		'KLNYAXOWHKBHUKVDDWFOSXNHYDS45M3KJW4HYJ6GOQB4LGAH4LJF57QVZI';
	const amountborrowing = 1000000;
	const xids = [xid];
	const camt = [collateralamt];
	const lamt = [loanamt];
	const USDC = 10458941;
	const DUSD = 84436770;
	const MNG = 84436122;
	const LQT = 84436752;
	/* let lsiga = algosdk.logicSigFromByte(borrowLogicSig);
	console.log(lsiga);
	console.log(lsiga.toByte()); */

	console.log('Logic sig here');
	let lsig = algosdk.LogicSigAccount.fromByte(borrowLogicSig);
	console.log(lsig.verify());
	//console.log(lsig.toByte());
	suggestedParams.flatFee = true;
	suggestedParams.fee = 0;
	const ptxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
		from: addressLogicSig, //Lender address
		to: address,
		amount: amountborrowing,
		assetIndex: USDC,
		suggestedParams,
	});

	// Construct TransactionWithSigner
	const tws = {
		txn: ptxn,
		signer: algosdk.makeLogicSigAccountTransactionSigner(lsig),
	};

	comp.addMethodCall({
		method: getMethodByName('borrow'),
		methodArgs: [
			tws,
			xids,
			camt,
			lamt,
			addressLogicSig,
			xids[0],
			DUSD,
			MNG,
			LQT,
		],
		...commonParams,
	});
	//const pay_txn = getPayTxn(suggested, sw.getDefaultAccount());

	//comp.addTransaction({ txn: pay_txn, signer: sw.getSigner() });

	// This is not necessary to call but it is helpful for debugging
	// to see what is being sent to the network
	const g = comp.buildGroup();
	console.log(g);
	for (const x in g) {
		//console.log(g[x].txn.appArgs);
	}

	const result = await comp.execute(testNetClientalgod, 2);
	console.log(result);
	for (const idx in result.methodResults) {
		//console.log(result.methodResults[idx]);
	}
	return result;
}

async function optinD4T(connector: WalletConnect, address: string) {
	const suggested = await apiGetTxnParams(ChainType.TestNet);
	const contract = await getContractAPI();

	console.log(contract);
	// Utility function to return an ABIMethod by its name
	function getMethodByName(name: string): algosdk.ABIMethod {
		const m = contract.methods.find((mt: algosdk.ABIMethod) => {
			return mt.name == name;
		});
		if (m === undefined) throw Error('Method undefined: ' + name);
		return m;
	}
	const signer = getSignerWC(connector, address);
	// We initialize the common parameters here, they'll be passed to all the transactions
	// since they happen to be the same
	const commonParams = {
		appID: contract.networks['default'].appID,
		sender: address,
		suggestedParams: suggested,
		onComplete: OnApplicationComplete.OptInOC,
		signer: signer,
	};
	const comp = new algosdk.AtomicTransactionComposer();

	const MNG = 84436122;

	comp.addMethodCall({
		method: getMethodByName('optin'),
		methodArgs: [MNG],
		...commonParams,
	});
	//const pay_txn = getPayTxn(suggested, sw.getDefaultAccount());

	//comp.addTransaction({ txn: pay_txn, signer: sw.getSigner() });

	// This is not necessary to call but it is helpful for debugging
	// to see what is being sent to the network
	const g = comp.buildGroup();
	console.log(g);

	const result = await comp.execute(testNetClientalgod, 2);
	console.log(result);

	return result;
}

async function borrowHack(
	address: string,
	xid: number,
	loanamt: number,
	collateralamt: number,
	addressLogicSig: string
) {
	const suggestedParams = await apiGetTxnParams(ChainType.TestNet);

	/* const addressLogicSig =
		'KLNYAXOWHKBHUKVDDWFOSXNHYDS45M3KJW4HYJ6GOQB4LGAH4LJF57QVZI'; */
	const amountborrowing = loanamt * 1000000;
	const assetID = algosdk.encodeUint64(xid);
	const camt = algosdk.encodeUint64(collateralamt);
	const lamt = algosdk.encodeUint64(amountborrowing);
	const APP_ID = 84436769;
	const USDC = 10458941;
	const DUSD = 84436770;
	const MNG = 84436122;
	const LQT = 84436752;
	const methodhash: Uint8Array = new Uint8Array(
		sha512.sha512_256
			.array(
				'borrow(uint64,uint64,uint64,account,asset,asset,application,application)void'
			)
			.slice(0, 4)
	);

	suggestedParams.flatFee = true;
	suggestedParams.fee = 0;
	const txn1 = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
		from: addressLogicSig, //Lender address
		to: address,
		amount: amountborrowing,
		assetIndex: USDC,
		suggestedParams,
	});

	suggestedParams.fee = 4000;
	const txn2 = algosdk.makeApplicationNoOpTxnFromObject({
		from: address,
		appIndex: APP_ID,
		appArgs: [methodhash, assetID, camt, lamt],
		foreignApps: [MNG, LQT],
		foreignAssets: [xid, DUSD],
		accounts: [addressLogicSig], //Lender address
		suggestedParams,
	});
	const txnsToSign = [{ txn: txn1, signers: [] }, { txn: txn2 }];
	algosdk.assignGroupID(txnsToSign.map((toSign) => toSign.txn));

	return [txnsToSign];
}
const borrowAppCall: Scenario = async (
	address: string,
	xid: number,
	loanamt: number,
	collateralamt: number,
	addressLogicSig: string
): Promise<ScenarioReturnType> => {
	return await borrowHack(
		address,
		xid,
		loanamt,
		collateralamt,
		addressLogicSig
	);
};
const Borrowscenarios: Array<{ name: string; scenario1: Scenario }> = [
	{
		name: 'Borrow',
		scenario1: borrowAppCall,
	},
];
async function signTxnLogic(
	scenario1: Scenario,
	connector: WalletConnect,
	address: string,
	xid: number,
	loanamt: number,
	collateralamt: number
) {
	try {
		let addressLogicSig: string;
		//'KLNYAXOWHKBHUKVDDWFOSXNHYDS45M3KJW4HYJ6GOQB4LGAH4LJF57QVZI';
		const us = await borrowIndexer(xid, loanamt);
		console.log(us?.buff);
		//console.log(us?.add);
		if (us?.add) addressLogicSig = us.add;
		const txnsToSign = await scenario1(
			address,
			xid,
			loanamt,
			collateralamt,
			addressLogicSig!
		);
		const flatTxns = txnsToSign.reduce((acc, val) => acc.concat(val), []);

		const walletTxns: IWalletTransaction[] = flatTxns.map(
			({ txn, signers, authAddr, message }) => ({
				txn: Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString(
					'base64'
				),
				signers, // TODO: put auth addr in signers array
				authAddr,
				message,
			})
		);
		// sign transaction
		const requestParams: SignTxnParams = [walletTxns];
		const request = formatJsonRpcRequest('algo_signTxn', requestParams);
		//console.log('Request param:', request);
		const result: Array<string | null> = await connector.sendCustomRequest(
			request
		);
		const indexToGroup = (index: number) => {
			for (let group = 0; group < txnsToSign.length; group++) {
				const groupLength = txnsToSign[group].length;
				if (index < groupLength) {
					return [group, index];
				}

				index -= groupLength;
			}

			throw new Error(`Index too large for groups: ${index}`);
		};

		const signedPartialTxns: Array<Array<Uint8Array | null>> = txnsToSign.map(
			() => []
		);
		result.forEach((r, i) => {
			const [group, groupIndex] = indexToGroup(i);
			const toSign = txnsToSign[group][groupIndex];

			if (r == null) {
				if (toSign.signers !== undefined && toSign.signers?.length < 1) {
					signedPartialTxns[group].push(null);
					return;
				}
				throw new Error(
					`Transaction at index ${i}: was not signed when it should have been`
				);
			}

			if (toSign.signers !== undefined && toSign.signers?.length < 1) {
				throw new Error(
					`Transaction at index ${i} was signed when it should not have been`
				);
			}

			const rawSignedTxn = Buffer.from(r, 'base64');
			signedPartialTxns[group].push(new Uint8Array(rawSignedTxn));
		});

		let borrowLogic: Uint8Array;
		/* let borrowLogic = await borrowGetLogic(
			'QmXJWc7jeSJ7F2Cc4cm6SSYdMnAiCG4M4gfaiQXvDbdAbL'
		); */
		if (us?.buff) borrowLogic = await borrowGetLogic(us.buff);

		//console.log('Logic sig here');
		let lsig = algosdk.LogicSigAccount.fromByte(borrowLogic!);
		console.log(lsig.verify());

		const signTxnLogicSigWithTestAccount = (
			txn: algosdk.Transaction
		): Uint8Array => {
			let signedTxn = algosdk.signLogicSigTransactionObject(txn, lsig);
			//console.log(signedTxn.txID);
			return signedTxn.blob;
		};
		const signedTxns: Uint8Array[][] = signedPartialTxns.map(
			(signedPartialTxnsInternal, group) => {
				return signedPartialTxnsInternal.map((stxn, groupIndex) => {
					if (stxn) {
						return stxn;
					}

					return signTxnLogicSigWithTestAccount(
						txnsToSign[group][groupIndex].txn
					);
				});
			}
		);
		signedTxns.forEach(async (signedTxn, index) => {
			try {
				const confirmedRound = await apiSubmitTransactions(
					ChainType.TestNet,
					signedTxn
				);
				console.log(`Transaction confirmed at round ${confirmedRound}`);
			} catch (err) {
				console.error(`Error submitting transaction: `, err);
			}
		});
	} catch (error) {}
}
export interface IScenarioTxn {
	txn: algosdk.Transaction;
	signers?: string[];
	authAddr?: string;
	message?: string;
}

export type ScenarioReturnType = IScenarioTxn[][];
export type Scenario = (
	address: string,
	xid: number,
	loanamt: number,
	collateralamt: number,
	addressLogicSig: string
) => Promise<ScenarioReturnType>;

async function repay(
	connector: WalletConnect,
	address: string,
	xid: number,
	repayamt: number
) {
	const suggested = await apiGetTxnParams(ChainType.TestNet);
	const suggestedParams = await apiGetTxnParams(ChainType.TestNet);
	const contract = await getContractAPI();

	//console.log(contract);
	// Utility function to return an ABIMethod by its name
	function getMethodByName(name: string): algosdk.ABIMethod {
		const m = contract.methods.find((mt: algosdk.ABIMethod) => {
			return mt.name == name;
		});
		if (m === undefined) throw Error('Method undefined: ' + name);
		return m;
	}
	const signer = getSignerWC(connector, address);
	suggested.flatFee = true;
	suggested.fee = 3000;
	// We initialize the common parameters here, they'll be passed to all the transactions
	// since they happen to be the same
	const commonParams = {
		appID: contract.networks['default'].appID,
		sender: address,
		suggestedParams: suggested,
		signer: signer,
	};
	const comp = new algosdk.AtomicTransactionComposer();

	const APP_ID = contract.networks['default'].appID;
	const xids = [xid];
	const ramt = [repayamt];
	const USDC = 10458941;
	const MNG = 84436122;
	const LQT = 84436752;
	suggestedParams.flatFee = true;
	suggestedParams.fee = 0;
	const ptxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
		from: address,
		to: algosdk.getApplicationAddress(APP_ID),
		amount: ramt[0],
		assetIndex: USDC,
		suggestedParams,
	});
	const tws = {
		txn: ptxn,
		signer: signer,
	};

	comp.addMethodCall({
		method: getMethodByName('repay'),
		methodArgs: [tws, xids, ramt, xids[0], MNG, LQT],
		...commonParams,
	});

	const result = await comp.execute(testNetClientalgod, 2);
	console.log('confirmedRound: ' + result.confirmedRound);

	return result;
}
function convert(amount: number, decimals: number) {
	return amount * Math.pow(10, decimals);
}
async function atomic(
	connector: WalletConnect,
	address: string,
	xid: number,
	aamt: number,
	address2: string,
	xid2: number,
	aamt2: number
) {
	const suggestedParams = await apiGetTxnParams(ChainType.TestNet);
	await redisClient.connect();
	const wcStr = await redisClient.get(address2);
	await redisClient.QUIT();
	const wcSession = JSON.parse(wcStr!);
	//console.log(wcSession.bridge);
	const connector2 = new WalletConnect({
		bridge: 'https://bridge.walletconnect.org', // Required
		clientMeta: {
			description: 'WalletConnect for DeFi4NFT; to Neos metaverse connection',
			url: 'https://defi4nft.herokuapp.com',
			icons: ['https://nodejs.org/static/images/logo.svg'],
			name: 'DeFi4NFT | Neos',
		},
		session: wcSession,
	});
	if (!connector2.connected) return console.log('NOT CONNECTED');
	//console.log(address2);
	/* const signer = getSignerWC(connector, address);
	const signer2 = getSignerWC(connector2, address2); */

	//const comp = new algosdk.AtomicTransactionComposer();

	let decimals = 6;
	if (xid !== 0)
		decimals = await testNetClientindexer
			.lookupAssetByID(xid)
			.do()
			.then((res) => {
				return res.asset.params['decimals'];
			})
			.catch((err) => {
				console.log(err);
				decimals = 6;
			});
	//console.log(assetInfo);
	//const decimal: number = assetInfo.asset.params['decimals'];
	let decimals2 = 6;
	if (xid2 !== 0)
		decimals2 = await testNetClientindexer
			.lookupAssetByID(xid2)
			.do()
			.then((res) => {
				return res.asset.params['decimals'];
			})
			.catch((err) => {
				console.log(err);
				decimals2 = 6;
			});

	const amt1 = convert(aamt, decimals);
	const amt2 = convert(aamt2, decimals2);

	let ptxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
		from: address,
		to: address2,
		amount: amt1,
		suggestedParams,
	});
	if (xid !== 0) {
		ptxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
			from: address,
			to: address2,
			amount: amt1,
			assetIndex: xid,
			suggestedParams,
		});
	}

	let ptxn2 = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
		from: address2,
		to: address,
		amount: amt2,
		suggestedParams,
	});
	if (xid2 !== 0) {
		ptxn2 = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
			from: address2,
			to: address,
			amount: amt2,
			assetIndex: xid2,
			suggestedParams,
		});
	}

	let txns = [ptxn, ptxn2];
	//console.log(txns);
	// Group both transactions
	let txgroup = algosdk.assignGroupID(txns);
	//algosdk.assignGroupID(txns); //.map((toSign) => toSign)
	//console.log(txns);
	// Sign transaction
	const signed1 = await signTxn(txns, connector, address);
	const signed2 = await signTxn(txns, connector2, address2);

	//console.log(signed1);

	const sig1: SignedTxn = signed1.find(
		(txn) => txn.blob.length !== 0
	) as SignedTxn;
	const sig2: SignedTxn = signed2.find(
		(txn) => txn.blob.length !== 0
	) as SignedTxn;
	console.log(sig1.txID);
	console.log(sig2.txID);
	try {
		let tx = await testNetClientalgod
			.sendRawTransaction([sig1.blob, sig2.blob])
			.do();
		console.log('Transaction : ' + tx.txId);
		// Wait for transaction to be confirmed
		const confirmedTxn = await algosdk.waitForConfirmation(
			testNetClientalgod,
			tx.txId,
			4
		);
		//Get the completed Transaction
		console.log(
			'Transaction ' +
				tx.txId +
				' confirmed in round ' +
				confirmedTxn['confirmed-round']
		);
		return confirmedTxn['confirmed-round'];
	} catch (error) {
		console.log(error);
	}

	/* const signedTxns: Uint8Array[][] = [[sig1.blob], [sig2.blob]];
	signedTxns.forEach(async (signedTxn, index) => {
		try {
			const confirmedRound = await apiSubmitTransactions(
				ChainType.TestNet,
				signedTxn
			);
			console.log(`Transaction confirmed at round ${confirmedRound}`);
		} catch (err) {
			console.error(`Error submitting transaction: `, err);
		}
	}); */
}
async function signTxn(
	txns: Transaction[],
	connector: WalletConnect,
	address: string
): Promise<SignedTxn[]> {
	const txnsToSign = txns.map((txn) => {
		const encodedTxn = Buffer.from(
			algosdk.encodeUnsignedTransaction(txn)
		).toString('base64');

		if (algosdk.encodeAddress(txn.from.publicKey) !== address) {
			return { txn: encodedTxn, signers: [] };
		}
		return { txn: encodedTxn };
	});
	//console.log(txnsToSign);
	const request = formatJsonRpcRequest('algo_signTxn', [txnsToSign]);

	const result: string[] = await connector.sendCustomRequest(request);

	return result.map((element, idx) => {
		return element
			? {
					txID: txns[idx].txID(),
					blob: new Uint8Array(Buffer.from(element, 'base64')),
			  }
			: {
					txID: txns[idx].txID(),
					blob: new Uint8Array(),
			  };
	});
}
export interface SignedTxn {
	txID: string;
	blob: Uint8Array;
}
async function claim(
	connector: WalletConnect,
	address: string,
	xid: number,
	claimamt: number
) {
	const suggested = await apiGetTxnParams(ChainType.TestNet);
	const suggestedParams = await apiGetTxnParams(ChainType.TestNet);
	const contract = await getContractAPI();

	//console.log(contract);
	// Utility function to return an ABIMethod by its name
	function getMethodByName(name: string): algosdk.ABIMethod {
		const m = contract.methods.find((mt: algosdk.ABIMethod) => {
			return mt.name == name;
		});
		if (m === undefined) throw Error('Method undefined: ' + name);
		return m;
	}
	const signer = getSignerWC(connector, address);
	suggested.flatFee = true;
	suggested.fee = 3000;
	// We initialize the common parameters here, they'll be passed to all the transactions
	// since they happen to be the same
	const commonParams = {
		appID: contract.networks['default'].appID,
		sender: address,
		suggestedParams: suggested,
		signer: signer,
	};
	const comp = new algosdk.AtomicTransactionComposer();

	const APP_ID = contract.networks['default'].appID;
	const xids = [xid];
	const claamt = [claimamt];
	const USDC = 10458941;
	const DUSD = 84436770;
	const MNG = 84436122;
	const LQT = 84436752;
	suggestedParams.flatFee = true;
	suggestedParams.fee = 0;
	const ptxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
		from: address,
		to: algosdk.getApplicationAddress(APP_ID),
		amount: claamt[0],
		assetIndex: DUSD,
		suggestedParams,
	});
	const tws = {
		txn: ptxn,
		signer: signer,
	};

	comp.addMethodCall({
		method: getMethodByName('claim'),
		methodArgs: [tws, USDC, MNG],
		...commonParams,
	});

	const result = await comp.execute(testNetClientalgod, 2);
	console.log('confirmedRound: ' + result.confirmedRound);
	return result;
}
async function mintNFT(
	connector: WalletConnect,
	address: string,
	description: string | null,
	decimals: number,
	url: string,
	assetName: string,
	unitName: string,
	typed4t: number
) {
	const suggestedParams = await apiGetTxnParams(ChainType.TestNet);
	const defaultFrozen = false;
	//console.log('Miniting NFT');
	let managerAddr =
		'EADMVBZHVH3KZE4MOGD67PSFPQODIMZRQ43CQPGVFFKS6EEJUUMHN4NKVU';
	let reserveAddr = address;
	let freezeAddr = 'UUKGU6YIC5YH5BJYYC4KQXXXBYGCJ4ITMXI3J4YEH2QUMV6JIGT2JATUG4';
	let clawbackAddr =
		'YMGJYNIXXGBZ3KSERBHQ2CXJGZJRYKR6VIA6XHOJFFTMPHJW2LJXF63JWA';
	if (typed4t === 0) {
		managerAddr = address;
		freezeAddr = address;
		clawbackAddr = address;
	}
	let metadata: md = {
		name: assetName,
		description: description ? description : '',
		image: '',
		decimals: decimals,
		unitName: unitName,
	};

	const regex = /(ipfs:)/g;
	let txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
		from: address,
		total: Math.pow(10, decimals),
		decimals,
		assetName,
		unitName,
		assetURL: url + '#arc3',
		//assetMetadataHash: metadatahash,
		defaultFrozen,
		freeze: freezeAddr,
		manager: managerAddr,
		clawback: clawbackAddr,
		reserve: reserveAddr,
		suggestedParams,
	});
	if (url && url.match(regex)) {
		try {
			const imageIpfs = url.split('/').pop()!.split('#')[0];
			const gatewayurl = `https://ipfs.io/ipfs/${imageIpfs}`;
			const stream = got.stream(gatewayurl);
			const type = await FileType.fromStream(stream);

			const chunks = [];
			for await (const chunk of ipfs.cat(imageIpfs)) {
				chunks.push(chunk);
			}
			const buffer = Buffer.concat(chunks);
			const dimensions = sizeOf(buffer);

			const bytes = new Uint8Array(buffer);
			const hash = new Uint8Array(sha256.digest(bytes));

			metadata = {
				...metadata,
				image: url,
				image_integrity: `sha256-${Buffer.from(hash).toString('base64')}`,
				image_mimetype: type?.mime,
				properties: {
					height: Number(dimensions.height),
					width: Number(dimensions.width),
				},
			};

			//console.log(metadata);
			let mdHash = sha256.digest(Buffer.from(JSON.stringify(metadata)));
			//const metadatahash = Buffer.from(new Uint8Array(mdHash)).toString('base64');
			const metadatahash8 = new Uint8Array(mdHash);

			txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
				from: address,
				total: Math.pow(10, decimals),
				decimals,
				assetName,
				unitName,
				assetURL: url + '#arc3',
				assetMetadataHash: metadatahash8,
				defaultFrozen,
				freeze: freezeAddr,
				manager: managerAddr,
				clawback: clawbackAddr,
				reserve: reserveAddr,
				suggestedParams,
			});
		} catch (err) {
			console.error(err);
		}
	}
	//return metadata;

	const txns = [txn];
	// Sign transaction
	const signed = await signTxn(txns, connector, address);
	const signedTxn: SignedTxn = signed.find(
		(txn) => txn.blob.length !== 0
	) as SignedTxn;
	try {
		let tx = await testNetClientalgod.sendRawTransaction([signedTxn.blob]).do();
		console.log('Transaction Mint Id : ' + tx.txId);
		// Wait for transaction to be confirmed
		const confirmedTxn = await algosdk.waitForConfirmation(
			testNetClientalgod,
			tx.txId,
			4
		);
		return confirmedTxn['confirmed-round'];
	} catch (error) {
		console.log(error);
	}
}
export type Properties = {
	[key: string]: string | number;
};
export type LocalizationIntegrity = {
	[key: string]: string;
};

export type Localization = {
	uri: string;
	default: string;
	locales: string[];
	integrity?: LocalizationIntegrity;
};
interface md {
	name: string;
	description: string | null;
	image: string;
	reserve?: string;
	decimals?: number;
	unitName?: string;
	image_mimetype?: string;
	image_integrity?: string;
	background_color?: string;
	external_url?: string;
	external_url_integrity?: string;
	external_url_mimetype?: string;

	animation_url?: string;
	animation_url_integrity?: string;
	animation_url_mimetype?: string;

	extra_metadata?: string;
	localization?: Localization;

	properties?: Properties;
}
// create a json making function from a string input of the form:
// borrow,xid,lamt,camt
// the json will be {type: 'borrow', values:{ xid: xid, lamt: lamt, camt: camt}}
function makeJsonFromString(str: string) {
	const arr = str.split(',');
	if (arr.length < 1) return { type: str, values: {} };
	const type = arr[0];
	const xid = arr[1];
	const amt = arr[2];
	let camt = '';
	//if(arr.length > 3) {}
	if (type === 'borrow') {
		camt = arr[3];
	} else if (type === 'atomic') {
		return {
			type: type,
			values: {
				address: arr[1],
				xid: arr[2],
				aamt: arr[3],
				address2: arr[4],
				xid2: arr[5],
				aamt2: arr[6],
			},
		};
	} else if (type === 'nft') {
		return {
			type: type,
			values: {
				description: arr[1],
				decimals: arr[2],
				url: arr[3],
				assetName: arr[4],
				unitName: arr[5],
				typed4t: arr[6],
			},
		};
	}

	return { type: type, values: { xid, amt, camt } };
}

const borrowIndexer = async (assetid: Number, amount: number) => {
	const APP_ID = 84436769;
	const USDC = 10458941;
	const accountsArray = await testNetClientindexer
		.searchAccounts()
		.applicationID(APP_ID)
		.do();

	//console.log(accountsArray.accounts);

	let numAccounts = accountsArray.accounts.length;

	let filteredAddress = [];
	outer: for (let i = 0; i < numAccounts; i++) {
		let add = accountsArray.accounts[i]['address'];

		let accountInfoResponse = await testNetClientindexer
			.lookupAccountAppLocalStates(add)
			.applicationID(APP_ID)
			.do();

		//filtering addresses by allowed amount or by liquidity provider
		if (accountInfoResponse['apps-local-states'][0]['key-value'] != undefined) {
			//console.log("User's local state: " + add);
			const kv = accountInfoResponse['apps-local-states'][0]['key-value'];
			//console.log(kv);
			for (let n = 0; n < kv.length; n++) {
				//kvaamt = kv.filter((kv: any) => kv[n]['key'] == 'YWFtdA==');
				if (kv[n]['key'] == 'YWFtdA==') {
					// Check amount allowed, then check available amount in account
					let kyv = kv[n]['value']['uint'];
					//console.log(kyv);
					// Check assetId balance

					const accountAssetInfo = await testNetClientalgod
						.accountAssetInformation(add, USDC)
						.do();

					const assetBalance = accountAssetInfo['asset-holding']['amount'];
					//console.log(assetBalance);
					const amountborrowing = amount * 1000000;
					if (assetBalance >= amountborrowing && kyv > amountborrowing) {
						// If aamt is equal or greater than available balance
						filteredAddress.push(add);
						continue outer;
					}
				}
			}
		}
		//console.log(filteredAddress);
	}
	outer: for (let i = 0; i < filteredAddress.length; i++) {
		let add: string = filteredAddress[i];

		let accountInfoResponse = await testNetClientindexer
			.lookupAccountAppLocalStates(add)
			.applicationID(APP_ID)
			.do();

		if (accountInfoResponse['apps-local-states'][0]['key-value'] != undefined) {
			console.log("User's local state: " + add);
			const kv = accountInfoResponse['apps-local-states'][0]['key-value'];
			//console.log(kv);
			for (let n = 0; n < kv.length; n++) {
				// checking for lvr
				if (kv[n]['key'] == 'bHZy') {
					let kyv = kv[n]['value']['uint'];
					const suggestedParams = await apiGetTxnParams(ChainType.TestNet);
					if (suggestedParams.lastRound > kyv) {
						const index = filteredAddress.indexOf(add);
						filteredAddress.splice(index, 1);
						continue outer;
					}
					//const a = kyv.filter((kyv: any) => suggestedParams.lastRound < kyv);
				}
			}
			for (let n = 0; n < kv.length; n++) {
				//checking for asset Id
				if (kv[n]['key'] == 'eGlkcw==') {
					let xid = kv[n]['value']['bytes'];

					//console.log(xid);
					let buff = Buffer.from(xid, 'base64');
					//console.log(buff.length);
					let values: Array<number> = [];
					for (let n = 0; n < buff.length; n = n + 8) {
						// Array offset, then check value
						values.push(Number(buff.readBigUInt64BE(n)));
					}
					//const value = Number(buff.readBigUInt64BE(0)); //readUIntBE(0, 8)
					//console.log(value);
					for (const va of values) {
						if (assetid !== va) {
							//foundId = true;
							const index = filteredAddress.indexOf(add);
							filteredAddress.splice(index, 1);
							continue outer;
						}
					}
				}
			}
			for (let n = 0; n < kv.length; n++) {
				//extracting address and ipfs logicsig
				if (kv[n]['key'] == 'bHNh') {
					let lsa = kv[n]['value']['bytes'];
					let buff = Buffer.from(lsa, 'base64').toString('utf-8');

					return { buff, add };
					break outer;
				}
			}
		}
	}
	//console.log(filteredAddress);
};

wss.on('connection', async function connection(ws: WebSocket) {
	console.log('connected new client');
	const walletConnector = new WalletConnect({
		bridge: 'https://bridge.walletconnect.org', // Required
		clientMeta: {
			description: 'Npneos-wallet; to Neos metaverse connection',
			url: 'https://npneos-wallet.herokuapp.com',
			icons: ['https://nodejs.org/static/images/logo.svg'],
			name: 'Np | Neos',
		},
	});

	ws.on('message', async function incoming(message: string) {
		const msg = message.toString();

		if (msg === 'i') {
		} else if (msg === 'wc') {
			try {
				// Check if connection is already established
				if (!walletConnector.connected) {
					// create new session
					walletConnector.createSession().then(() => {
						// get uri for QR Code modal
						const uri = walletConnector.uri;
						ws.send(uri);
						// encodeURIComponent
					});
				}
				// Subscribe to connection events
				walletConnector.on('connect', async (error, payload) => {
					if (error) {
						throw error;
					}

					// Close QR Code Modal
					const { accounts } = payload.params[0];
					const address = accounts[0];
					console.log(`onConnect: ${address}`);
					await redisClient.connect();
					await redisClient.setEx(
						address,
						DEFAULT_EXPIRATION,
						JSON.stringify(walletConnector.session)
					);
					await redisClient.QUIT();
					ws.send(address);
				});

				walletConnector.on('session_update', (error, payload) => {
					if (error) {
						throw error;
					}

					// Get updated accounts
					const { accounts } = payload.params[0];
					onSessionUpdate(accounts);
				});

				walletConnector.on('disconnect', (error, payload) => {
					if (error) {
						throw error;
					}
					// Delete walletConnector
					if (walletConnector) {
						//walletConnector.killSession();
						walletConnector.off;
					}
					walletConnector.connected = false;
				});
				if (walletConnector.connected) ws.send(walletConnector.accounts[0]);
			} catch (error) {
				console.error(error);
			}
		} else if (msg === 'address') {
			if (walletConnector.connected) {
				console.log('Address');
				ws.send(walletConnector.accounts[0]);
			}
		} else if (msg === 'optin') {
			if (walletConnector.connected) {
				console.log('optin');
				try {
					await optinD4T(walletConnector, walletConnector.accounts[0]);
				} catch (error) {
					console.log(error);
				}
			}
		} else if (msg === 'close') {
			console.log('closing...');
			ws.close();
		}
		try {
			if (msg !== 'i' && msg !== 'wc' && msg !== 'address') {
				const jformat = makeJsonFromString(msg);
				console.log(jformat);
				if (jformat.type === 'borrow') {
					if (walletConnector.connected) {
						console.log('borrow');
						try {
							//check if xid, amt and camt are present
							if (
								jformat.values.xid &&
								jformat.values.amt &&
								jformat.values.camt
							) {
								const xid: number = Number(jformat.values.xid); //97931298
								const loanamt: number = Number(jformat.values.amt);
								const collateralamt: number = Number(jformat.values.camt);
								/* await wcborrow(
									walletConnector,
									walletConnector.accounts[0],
									xid,
									loanamt,
									collateralamt
								); */
								Borrowscenarios.map(({ name, scenario1 }) =>
									signTxnLogic(
										scenario1,
										walletConnector,
										walletConnector.accounts[0],
										xid,
										loanamt,
										collateralamt
									)
								);
							}
						} catch (error) {
							console.log(error);
						}
					}
				} else if (jformat.type === 'repay') {
					if (walletConnector.connected) {
						console.log('repay');
						try {
							//check if xid, amt and camt are present
							if (
								jformat.values.xid &&
								jformat.values.amt //jformat.values.camt
							) {
								const xid: number = Number(jformat.values.xid);
								const repayamt: number = Number(jformat.values.amt) * 1000000;
								await repay(
									walletConnector,
									walletConnector.accounts[0],
									xid,
									repayamt
								);
							}
						} catch (error) {
							console.log(error);
						}
					}
				} else if (jformat.type === 'claim') {
					if (walletConnector.connected) {
						console.log('claim');
						try {
							if (jformat.values.xid && jformat.values.amt) {
								const xid: number = Number(jformat.values.xid);
								const claimamt: number = Number(jformat.values.amt) * 1000000;
								await claim(
									walletConnector,
									walletConnector.accounts[0],
									xid,
									claimamt
								);
							}
						} catch (error) {
							console.log(error);
						}
					}
				} else if (jformat.type === 'circle') {
					if (walletConnector.connected) {
						try {
							if (jformat.values.xid) {
								const chain = jformat.values.xid;
								let uuid = uuidv4();

								const circle = await getAddress(
									uuid,
									chain.toUpperCase(),
									walletConnector.accounts[0]
								);
								if (circle !== 'error') ws.send(circle);
							}
						} catch (error) {
							console.log(error);
						}
					}
				} else if (jformat.type === 'extract') {
					if (walletConnector.connected) {
						try {
							if (jformat.values.xid) {
								let index = Math.abs(Number(jformat.values.xid));
								const assets = await apiGetAccountAssets(
									ChainType.TestNet,
									walletConnector.accounts[0]
								);
								if (assets.length < 1) index = 0;
								const at = index % assets.length;
								const returns = assets[at];

								const regex = /(ipfs:)/g;
								if (returns.url && returns.url.match(regex)) {
									let ipfsUrl = returns.url.split('/').pop()!.split('#')[0];

									const { data } = await axios.get(
										`https://ipfs.io/ipfs/${ipfsUrl}#x-ipfs-companion-no-redirect`
									);
									if (data.image) {
										const imageIpfs = data.image.split('/').pop();
										console.log('1|');
										ws.send(
											`1|${returns.id}:${returns.unitName};https://ipfs.io/ipfs/${imageIpfs}`
										);
									} else {
										ws.send(
											`0|${returns.id}:${returns.unitName};${returns.url}`
										);
									}
								} else {
									ws.send(`0|${returns.id}:${returns.unitName};${returns.url}`);
								}
							}
						} catch (error) {
							console.log(error);
						}
					}
				} else if (jformat.type === 'atomic') {
					if (walletConnector.connected) {
						console.log('atomic');
						try {
							if (
								jformat.values.xid &&
								jformat.values.aamt &&
								jformat.values.address2 &&
								jformat.values.xid2 &&
								jformat.values.aamt2
							) {
								const address: string = jformat.values.address;
								const xid: number = Number(jformat.values.xid);
								const aamt: number = Number(jformat.values.aamt);
								const address2: string = jformat.values.address2;
								const xid2: number = Number(jformat.values.xid2);
								const aamt2: number = Number(jformat.values.aamt2);
								// check if address or address2 is equal to walletConnector.accounts[0]
								if (address === walletConnector.accounts[0]) {
									await atomic(
										walletConnector,
										walletConnector.accounts[0],
										xid,
										aamt,
										address2,
										xid2,
										aamt2
									);
								} else if (address2 === walletConnector.accounts[0]) {
									await atomic(
										walletConnector,
										walletConnector.accounts[0],
										xid2,
										aamt2,
										address,
										xid,
										aamt
									);
								}
							}
							/* wss.clients.forEach(async function each(client) {
						
						if (client !== ws && client.readyState === WebSocket.OPEN) {
							console.log(walletConnector.session);
							console.log(walletConnector.peerMeta);
						}
					}); */
						} catch (error) {
							console.log(error);
						}
					}
					/* let xid = 0;
					let j = xid;
					console.log('Herer');
					if (xid === 0) {
						j = 97927840;
					} else {
						j = 97931298;
					}
					try {
						//const assetInfo2 = await testNetClientindexer.lookupAssetByID(j).do();
						const decimals2 = await testNetClientalgod.getAssetByID(j).do();
						console.log('Here never');
						console.log(decimals2);
						//console.log(assetInfo2);
					} catch (error) {
						console.log(error);
					} */
				} else if (jformat.type === 'nft') {
					if (walletConnector.connected) {
						console.log('nft Miniting...');
						try {
							const v = jformat.values;
							if (v.description && v.decimals && v.unitName && v.typed4t) {
								await mintNFT(
									walletConnector,
									walletConnector.accounts[0],
									v.description,
									Number(v.decimals),
									v.url,
									v.assetName,
									v.unitName,
									Number(v.typed4t)
								);
							}
						} catch (error) {
							console.log(error);
						}
					}
				} else if (jformat.type === 'address') {
					if (walletConnector.connected) {
						const address = walletConnector.accounts[0];
						console.log(address);
						try {
							ws.send(address);
						} catch (error) {
							console.log(error);
						}
					}
				}
			}
		} catch (error) {}
	});
	ws.on('close', function close() {
		console.log('disconnected');
	});
});

wss.on('close', function close() {
	console.log('disconnected wss');
});
app.get('/', async (req: Request, res: Response, next: NextFunction) => {
	try {
		//const { data } = await axios.get(`https://api.chucknorris.io/jokes/random`);

		const assetInfo = await testNetClientalgod.getAssetByID(84957464).do();
		const str = assetInfo.params.url;
		const ipfsUrl = str.split('/').pop().split('#')[0];
		//console.log(ipfsUrl);
		const { data } = await axios.get(
			`https://ipfs.io/ipfs/${ipfsUrl}#x-ipfs-companion-no-redirect`
		);
		if (data.image) {
			const imageIpfs = data.image.split('/').pop();
			const url = `https://ipfs.io/ipfs/${imageIpfs}`;
			console.log(url);

			res.status(200).send(url);
		}
		//res.status(200).send(assets);
	} catch (error) {
		next(error);
	}
});
app.get('/circle', async (req: Request, res: Response, next: NextFunction) => {
	try {
		//const pingRes = await signATC();
		const circle = await checkStatus();
		res.status(200).send(circle);
	} catch (error) {
		next(error);
	}
});
app.get('/test_cb', async (req: Request, res: Response, next: NextFunction) => {
	try {
		let uuid = uuidv4();
		const chain: string = req.query.chain as string;
		const address: string = req.query.address as string;
		const circle = await getAddress(uuid, chain, address);
		console.log(circle);
		if (circle !== 'error') res.status(200).send(circle);

		next('next');
	} catch (error) {
		next(error);
	}
});
app.get('/test_ex', async (req: Request, res: Response, next: NextFunction) => {
	try {
		let index = Math.abs(Number(req.query.id));
		const assets = await apiGetAccountAssets(
			ChainType.TestNet,
			req.query.address as string
		);
		if (assets.length < 1) index = 0;
		const at = index % assets.length;
		const returns = assets[at];
		res.send(`${returns.id}:${returns.unitName}:${returns.url}`);
	} catch (error) {
		next(error);
	}
});
app.post('/ping/:id', (req: Request, res: Response, next: NextFunction) => {
	const { id } = req.params;
	const { pong } = req.body;

	if (!pong) {
		res.status(418).send({ message: 'Need a PONG!' });
	}
	res.status(201).send({ pong: ` ${pong} and ID ${id}` });
});

server.listen(PORT, () => {
	console.log(`Server started on port ${PORT}`);
});

//console.log('websocket server created');

/* wss.on('connection', function (ws) {
	var id = setInterval(function () {
		ws.send(JSON.stringify(new Date()), function () {});
	}, 1000);

	console.log('websocket connection open');

	ws.on('close', function () {
		console.log('websocket connection close');
		clearInterval(id);
	});
}); */
