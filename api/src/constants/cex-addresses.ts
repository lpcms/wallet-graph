// ===== CEX / ИЗВЕСТНЫЕ АДРЕСА =====
// Адреса крупных бирж и сервисов на Ethereum mainnet.
// Любой адрес отсюда получает nodeType = 'EXCHANGE' и не участвует
// в кластеризации и анализе "умных денег".

export const CEX_ADDRESSES = new Map<string, string>([
  // Binance
  ['0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be', 'Binance'],
  ['0xd551234ae421e3bcba99a0da6d736074f22192ff', 'Binance 2'],
  ['0x564286362092d8e7936f0549571a803b203aaced', 'Binance 3'],
  ['0x0681d8db095565fe8a346fa0277bffde9c0edbbf', 'Binance 4'],
  ['0xfe9e8709d3215310075d67e3ed32a380ccf451c8', 'Binance 5'],
  ['0x4e9ce36e442e55ecd9025b9a6e0d88485d628a67', 'Binance 6'],
  ['0xbe0eb53f46cd790cd13851d5eff43d12404d33e8', 'Binance 7'],
  ['0xf977814e90da44bfa03b6295a0616a897441acec', 'Binance 8'],
  ['0x001866ae5b3de6caa5a51543fd9fb64f524f5478', 'Binance 9'],
  ['0x85b931a32a0725be14285b66f1a22178c672d69b', 'Binance 10'],
  ['0x708396f17127c42383e3b9014072679b2f60b82f', 'Binance 11'],
  ['0xe0f0cfde7ee664943906f17f7f14342a76a3b760', 'Binance 12'],
  ['0x8f22f2063d253846b53609231ed80fa571bc0c8f', 'Binance 13'],
  ['0x28c6c06298d514db089934071355e5743bf21d60', 'Binance 14'],
  ['0x21a31ee1afc51d94c2efccaa2092ad1028285549', 'Binance 15'],
  // Coinbase
  ['0x71660c4005ba85c37ccec55d0c4493e66fe775d3', 'Coinbase'],
  ['0x503828976d22510aad0201ac7ec88293211d23da', 'Coinbase 2'],
  ['0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740', 'Coinbase 3'],
  ['0x3cd751e6b0078be393132286c442345e5dc49699', 'Coinbase 4'],
  ['0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511', 'Coinbase 5'],
  ['0xeb2629a2734e272bcc07bda959863f316f4bd4cf', 'Coinbase 6'],
  ['0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', 'Coinbase 7'],
  ['0x77696bb39917c91a0c3d2f859fd351c42a5a79ac', 'Coinbase 8'],
  ['0x7c195d981abfdc3ddecd2ca0fed0958430488e34', 'Coinbase 9'],
  ['0x95a9bd206ae52c4ba8eecfc93d18eebfef04902c', 'Coinbase 10'],
  // Kraken
  ['0x2910543af39aba0cd09dbb2d50200b3e800a63d2', 'Kraken'],
  ['0xcef4c6c7af5c6efbc28d0f82de1f4dce22ee1e1c', 'Kraken 2'],
  ['0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0', 'Kraken 3'],
  ['0xfa52274dd61e1643d2205169732f29114bc240b3', 'Kraken 4'],
  ['0x53d284357ec70ce289d6d64134dfac8e511c8a3d', 'Kraken 5'],
  ['0x89e51fa8ca5d66cd220baed62ed01e8951aa7c40', 'Kraken 6'],
  // OKX
  ['0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', 'OKX'],
  ['0x236f9f97e0e62388479bf9e5ba4889e46b0273c3', 'OKX 2'],
  ['0xa7efae728d2936e78bda97dc267687568dd593f3', 'OKX 3'],
  // Huobi / HTX
  ['0xabd4c63d2616a5201454168269031355f4764337', 'Huobi'],
  ['0x6748f50f686bfbca6fe8ad62b22228b87f31ff2b', 'Huobi 2'],
  ['0xfdb16996831753d5331ff813c29a93c76834a0ad', 'Huobi 3'],
  ['0x46705dfff24256421a05d056c29e81bdc09723b8', 'Huobi 4'],
  ['0x32598293906b5b17c27d657db3ad2c9b3f3e4265', 'Huobi 5'],
  // Bitfinex
  ['0x742d35cc6634c0532925a3b844bc454e4438f44e', 'Bitfinex'],
  ['0x876eabf441b2ee5b5b0554fd502a8e0600950cfa', 'Bitfinex 2'],
  ['0xd24400ae8bfebb18ca49be86258a3c749cf46853', 'Bitfinex 3'],
  // KuCoin
  ['0x2b5634c42055806a59e9107ed44d43c426e58258', 'KuCoin'],
  ['0xa1d8d972560c2f8144af871db508f0b0b10a3fbf', 'KuCoin 2'],
  ['0x689c56aef474df92d44a1b70850f808488f9769c', 'KuCoin 3'],
  // Crypto.com
  ['0x6262998ced04146fa42253a5c0af90ca02dfd2a3', 'Crypto.com'],
  ['0x46340b20830761efd32832a74d7169b29feb9758', 'Crypto.com 2'],
  // Gemini
  ['0x07ee55aa48bb72dcc6e9d78256648910de513eca', 'Gemini'],
  ['0x6fc82a5fe25a5cdb58bc74600a40a69c065263f8', 'Gemini 2'],
  // Протоколы / контракты
  ['0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae', 'Ethereum Foundation'],
  ['0x00000000219ab540356cbb839cbe05303d7705fa', 'ETH2 Deposit Contract'],
  ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'WETH Contract'],
  ['0x7a250d5630b4cf539739df2c5dacb4c659f2488d', 'Uniswap V2 Router'],
  ['0xe592427a0aece92de3edee1f18e0157c05861564', 'Uniswap V3 Router'],
  ['0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', 'Uniswap V3 Router 2'],
  ['0x1111111254fb6c44bac0bed2854e76f90643097d', '1inch v4'],
  ['0x1111111254eeb25477b68fb85ed929f73a960582', '1inch v5'],
  ['0xdef1c0ded9bec7f1a1670819833240f027b25eff', '0x Protocol'],
  ['0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', 'SushiSwap Router'],
])
