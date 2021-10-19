import {
  ChainAdapter,
  BuildSendTxInput,
  FeeData,
  ChainIdentifier,
  ValidAddressResult,
  ValidAddressResultType,
  GetAddressParams,
  Params,
  SignBitcoinTxInput,
  Recipient,
  BTCFeeData
} from '../api'
import { ErrorHandler } from '../error/ErrorHandler'
import { bip32ToAddressNList, BTCInputScriptType, BTCSignTx } from '@shapeshiftoss/hdwallet-core'
import axios from 'axios'
import { Bitcoin } from '@shapeshiftoss/unchained-client'
import WAValidator from 'multicoin-address-validator'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const coinSelect = require('coinselect')

const MIN_RELAY_FEE = 3000 // sats/kbyte
const DEFAULT_FEE = undefined

const UNCHAINED_API_BASE_URL = process.env.UNCHAINED_API_BASE_URL
if (!UNCHAINED_API_BASE_URL) throw new Error('UNCHAINED_API_BASE_URL env var not set')

export type BitcoinChainAdapterDependencies = {
  provider: Bitcoin.V1Api
}

export class BitcoinChainAdapter implements ChainAdapter {
  private readonly provider: Bitcoin.V1Api

  constructor(deps: BitcoinChainAdapterDependencies) {
    this.provider = deps.provider
  }

  getType = (): ChainIdentifier => {
    return ChainIdentifier.Bitcoin
  }

  getAccount = async (address: string): Promise<Bitcoin.BitcoinAccount> => {
    if (!address) {
      // return ErrorHandler(new Error('Address parameter is not defined'))
      return ErrorHandler('Address parameter is not defined')
    }
    try {
      const { data } = await this.provider.getAccount({ pubkey: address })
      return data
    } catch (err) {
      return ErrorHandler(err)
    }
  }

  getTxHistory = async (address: string, params?: Params): Promise<Bitcoin.TxHistory> => {
    if (!address) {
      // return ErrorHandler(new Error('Address parameter is not defined'))
      return ErrorHandler('Address parameter is not defined')
    }
    try {
      const { data } = await this.provider.getTxHistory({ pubkey: address, ...params })
      return data
    } catch (err) {
      return ErrorHandler(err)
    }
  }

  buildSendTransaction = async (
    tx: BuildSendTxInput
  ): Promise<{ txToSign: BTCSignTx; estimatedFees?: FeeData } | undefined> => {
    try {
      const {
        recipients,
        fee: satoshiPerByte,
        wallet,
        opReturnData,
        purpose = 84,
        scriptType = BTCInputScriptType.SpendWitness,
        account = 0
      } = tx
      const publicKeys = await wallet.getPublicKeys([
        {
          coin: 'Bitcoin',
          addressNList: bip32ToAddressNList(`m/${String(purpose)}'/0'/${String(account)}'`),
          curve: 'secp256k1',
          scriptType: scriptType ? scriptType : BTCInputScriptType.SpendWitness
        }
      ])
      if (publicKeys) {
        const pubkey = publicKeys[0].xpub
        const { data: utxos } = await this.provider.getUtxos({
          pubkey
        })

        const changeAddress = await this.getAddress({
          wallet,
          purpose,
          account,
          isChange: true,
          scriptType: BTCInputScriptType.SpendWitness
        })

        const formattedUtxos = []
        for (const utxo of utxos) {
          const getTransactionResponse = await this.provider.getTransaction({
            txid: utxo.txid
          })

          const inputTx = getTransactionResponse.data
          if (utxo.path) {
            formattedUtxos.push({
              ...utxo,
              addressNList: bip32ToAddressNList(utxo.path),
              scriptType: BTCInputScriptType.SpendAddress,
              amount: String(utxo.value),
              tx: inputTx,
              hex: inputTx.hex,
              value: Number(utxo.value)
            })
          }
        }

        const { inputs, outputs, fee } = coinSelect(
          formattedUtxos,
          recipients,
          Number(satoshiPerByte)
        )

        //TODO some better error handling
        if (!inputs || !outputs) {
          ErrorHandler('Error selecting inputs/outputs')
        }

        const formattedOutputs = outputs.map((out: Recipient) => {
          if (!out.address) {
            return {
              amount: String(out.value),
              addressType: BTCInputScriptType.SpendWitness,
              address: changeAddress,
              isChange: true
            }
          }
          return {
            ...out,
            amount: String(out.value),
            addressType: BTCInputScriptType.SpendWitness,
            isChange: false
          }
        })

        const txToSign = {
          coin: 'bitcoin',
          inputs,
          outputs: formattedOutputs,
          fee,
          opReturnData
        }
        return { txToSign }
      } else {
        return undefined
      }
    } catch (err) {
      return ErrorHandler(err)
    }
  }

  signTransaction = async (signTxInput: SignBitcoinTxInput): Promise<string> => {
    try {
      const { txToSign, wallet } = signTxInput
      const signedTx = await wallet.btcSignTx(txToSign)
      if (!signedTx) ErrorHandler('Error signing tx')

      return signedTx.serializedTx
    } catch (err) {
      return ErrorHandler(err)
    }
  }

  broadcastTransaction = async (hex: string): Promise<string> => {
    const broadcastedTx = await this.provider.sendTx({ sendTxBody: { hex } })
    return broadcastedTx.data
  }

  getFeeData = async (): Promise<FeeData> => {
    return (await axios.get<BTCFeeData>(UNCHAINED_API_BASE_URL + '/fees')).data
  }

  getAddress = async ({
    wallet,
    purpose = 84,
    account = 0,
    isChange = false,
    index,
    scriptType = BTCInputScriptType.SpendWitness
  }: GetAddressParams): Promise<string | undefined> => {
    const change = isChange ? '1' : '0'

    // If an index is not passed in, we want to use the newest unused change/receive indices
    if (index === undefined) {
      const publicKeys = await wallet.getPublicKeys([
        {
          coin: 'Bitcoin',
          addressNList: bip32ToAddressNList(`m/${String(purpose)}'/0'/0'`),
          curve: 'secp256k1',
          scriptType
        }
      ])
      if (publicKeys) {
        const pubkey = publicKeys[0].xpub
        const accountData:Bitcoin.BitcoinAccount = await this.getAccount(pubkey)
        index = (isChange ? accountData.changeIndex : accountData.receiveIndex) || undefined
      } else {
        return ErrorHandler(new Error("Unable to get wallet's pubkeys"))
      }
    }

    const path = `m/${String(purpose)}'/0'/${String(account)}'/${change}/${index}`
    const addressNList = path ? bip32ToAddressNList(path) : bip32ToAddressNList("m/84'/0'/0'/0/0")
    const btcAddress = await wallet.btcGetAddress({
      addressNList,
      coin: 'bitcoin',
      scriptType
    })
    return btcAddress
  }

  async validateAddress(address: string): Promise<ValidAddressResult> {
    const isValidAddress = WAValidator.validate(address, this.getType())
    if (isValidAddress) return { valid: true, result: ValidAddressResultType.Valid }
    return { valid: false, result: ValidAddressResultType.Invalid }
  }
}
