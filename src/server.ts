import express from 'express';
import WalletConnect from '@walletconnect/node';

// Create a connector
const connector = new WalletConnect(
	{
		bridge: 'https://bridge.walletconnect.org', // Required
	},

	{
		clientMeta: {
			description: 'WalletConnect NodeJS Client',
			url: 'https://nodejs.org/en/',
			icons: ['https://nodejs.org/static/images/logo.svg'],
			name: 'WalletConnect',
		},
	}
);
const PORT = process.env.PORT || 3000;
const app: express.Application = express();

app.get('/', (req, res) => {
	res.send('Hello World!');
});

app.listen(8080, () => {
	console.log(`Example app listening on port ${PORT}!`);
});
