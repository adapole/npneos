import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { baseUrl } from './algodfunct';

export const baseUrl2 = 'https://defi4nft.vercel.app';

export const checkStatus = async () => {
	try {
		const { data } = await axios.get(`${baseUrl}/api/status`);
		return data;
	} catch (error) {
		console.error(error);
	}
};

export const getWallets = async (address: string) => {
	try {
		const postData = {
			address: address,
		};

		const axiosConfig = {
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
			},
		};
		const response = await axios.post(
			`${baseUrl2}/api/getwalletids`,
			postData,
			axiosConfig
		);
		//console.log(response.data);
		return response.data;
	} catch (error) {
		console.error(error);
	}
};

// check if the response of getwallets has a name neos
// if it doesn't have a name, then create a wallet
// if it does have a name, then generate an address
export const getAddress = async (
	id: string,
	chain: string,
	algorand: string
) => {
	try {
		const postData = {
			idempotencyKey: id,
			description: 'neos',
			algorand: algorand,
		};
		const axiosConfig = {
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
			},
		};
		const data = await getWallets(algorand);
		console.log(data.length);
		let hasNeos = false;
		let hasChainAddress = false;
		for (let n = 0; n < data.length; n++) {
			//check if data.name is neos
			if (data[n].name === 'neos') {
				console.log('has neos');
				hasNeos = true;

				//check if data.walletid has a chain
				const listAddress = await axios.get(
					`${baseUrl}/api/address/${data[n].walletid}`
				);
				const message = JSON.parse(listAddress.data.message);
				const cdata = message.data;
				for (let n = 0; n < cdata.length; n++) {
					if (cdata[n].chain == chain) {
						hasChainAddress = true;
						return cdata[n].address;
					}
				}
				if (!hasChainAddress) {
					console.log('does not have chain address');
					//if it is, then generate an address
					const response = await axios.post(
						`${baseUrl}/api/address`,
						{
							idempotencyKey: id,
							chain: chain,
							walletId: data[n].walletid,
						},
						axiosConfig
					);
					//console.log(response.data);
					const newAddress = JSON.parse(response.data.message).data.address;
					return newAddress;
				}
			}
		}
		if (!hasNeos) {
			console.log('does not have neos');
			//if it doesn't have a name, then create a wallet
			const cresponse = await axios.post(
				`${baseUrl}/api/wallet`,
				postData,
				axiosConfig
			);

			const dataw = cresponse.data;

			console.log(dataw.walletId);
			//create address
			const uuid = uuidv4();
			const response2 = await axios.post(
				`${baseUrl}/api/address`,
				{
					idempotencyKey: uuid,
					chain: chain,
					walletId: dataw.walletId,
				},
				axiosConfig
			);
			console.log(response2.data);
			const newAddress = JSON.parse(response2.data.message).data.address;
			return newAddress;
		}
	} catch (error) {
		return 'error';
	}
};
