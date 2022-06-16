import * as fs from 'fs';
import WalletConnect from '@walletconnect/node';
require('dotenv').config();
import algosdk, { Transaction, TransactionSigner } from 'algosdk';
import { SignTxnParams } from './types';
import { formatJsonRpcRequest } from '@json-rpc-tools/utils';
import { IInternalEvent } from '@walletconnect/types';
require('dotenv').config();

// Create connector

export enum ChainType {
	MainNet = 'mainnet',
	TestNet = 'testnet',
}
export interface IAssetData {
	id: number;
	amount: bigint | number;
	creator: string;
	frozen: boolean;
	decimals: number;
	name?: string;
	unitName?: string;
	url?: string;
}
const baseServer = 'https://testnet-algorand.api.purestake.io/ps2';
const baseServerIndexer = 'https://testnet-algorand.api.purestake.io/idx2';
const pport = '';
const token = {
	'X-API-Key': process.env.PURESTAKE_API ?? '',
};

const mainNetClient = new algosdk.Algodv2('', 'https://algoexplorerapi.io', '');
export const testNetClientalgod = new algosdk.Algodv2(token, baseServer, pport);
export const testNetClientindexer = new algosdk.Indexer(
	token,
	baseServerIndexer,
	pport
);
function clientForChain(chain: ChainType): algosdk.Algodv2 {
	switch (chain) {
		case ChainType.MainNet:
			return mainNetClient;
		case ChainType.TestNet:
			return testNetClientalgod;
		default:
			throw new Error(`Unknown chain type: ${chain}`);
	}
}

export async function apiGetAccountAssets(
	chain: ChainType,
	address: string
): Promise<IAssetData[]> {
	const client = clientForChain(chain);

	const accountInfo = await client
		.accountInformation(address)
		.setIntDecoding(algosdk.IntDecoding.BIGINT)
		.do();

	const algoBalance = accountInfo.amount as bigint;
	const assetsFromRes: Array<{
		'asset-id': bigint;
		amount: bigint;
		creator: string;
		frozen: boolean;
	}> = accountInfo.assets;

	const assets: IAssetData[] = assetsFromRes.map(
		({ 'asset-id': id, amount, creator, frozen }) => ({
			id: Number(id),
			amount,
			creator,
			frozen,
			decimals: 0,
		})
	);

	assets.sort((a, b) => a.id - b.id);

	await Promise.all(
		assets.map(async (asset) => {
			const { params } = await client.getAssetByID(asset.id).do();
			asset.name = params.name;
			asset.unitName = params['unit-name'];
			asset.url = params.url;
			asset.decimals = params.decimals;
		})
	);

	assets.unshift({
		id: 0,
		amount: algoBalance,
		creator: '',
		frozen: false,
		decimals: 6,
		name: 'Algo',
		unitName: 'Algo',
	});

	return assets;
}

export async function apiGetTxnParams(
	chain: ChainType
): Promise<algosdk.SuggestedParams> {
	const params = await clientForChain(chain).getTransactionParams().do();
	return params;
}

export async function apiSubmitTransactions(
	chain: ChainType,
	stxns: Uint8Array[]
): Promise<number> {
	const { txId } = await clientForChain(chain).sendRawTransaction(stxns).do();
	return await waitForTransaction(chain, txId);
}

async function waitForTransaction(
	chain: ChainType,
	txId: string
): Promise<number> {
	const client = clientForChain(chain);

	let lastStatus = await client.status().do();
	let lastRound = lastStatus['last-round'];
	while (true) {
		const status = await client.pendingTransactionInformation(txId).do();
		if (status['pool-error']) {
			throw new Error(`Transaction Pool Error: ${status['pool-error']}`);
		}
		if (status['confirmed-round']) {
			return status['confirmed-round'];
		}
		lastStatus = await client.statusAfterBlock(lastRound + 1).do();
		lastRound = lastStatus['last-round'];
	}
}

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

	/* return txns.map((txn) => {
		return {
			txID: txn.txID(),
			blob: new Uint8Array(),
		};
	}); */

	const request = formatJsonRpcRequest('algo_signTxn', requestParams);
	//console.log('Request param:', request);
	const result: Array<string | null> = await connector.sendCustomRequest(
		request
	);

	console.log('Raw response:', result);
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
export async function getContractAPI(): Promise<algosdk.ABIContract> {
	const buff = fs.readFileSync('./d4t.json');

	return new algosdk.ABIContract(JSON.parse(buff.toString()));
}

export async function signATC() {
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
	const acct = algosdk.mnemonicToSecretKey(
		'about delay bar pizza item art nerve purpose vivid system assume army basket vote spatial dutch term army top urge link student patient about spray'
	);

	// We initialize the common parameters here, they'll be passed to all the transactions
	// since they happen to be the same
	const commonParams = {
		appID: contract.networks['default'].appID,
		sender: acct.addr,
		suggestedParams: suggested,
		signer: algosdk.makeBasicAccountTransactionSigner(acct),
	};
	const comp = new algosdk.AtomicTransactionComposer();

	// Simple ABI Calls with standard arguments, return type
	comp.addMethodCall({
		method: getMethodByName('test'),
		methodArgs: ['ping'],
		...commonParams,
	});
	//const pay_txn = getPayTxn(suggested, sw.getDefaultAccount());

	//comp.addTransaction({ txn: pay_txn, signer: sw.getSigner() });

	// This is not necessary to call but it is helpful for debugging
	// to see what is being sent to the network
	const g = comp.buildGroup();
	console.log(g);
	for (const x in g) {
		console.log(g[x].txn.appArgs);
	}

	const result = await comp.execute(testNetClientalgod, 2);
	console.log(result);
	for (const idx in result.methodResults) {
		console.log(result.methodResults[idx]);
	}
	return result;
}
