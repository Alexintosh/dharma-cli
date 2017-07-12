import prompt from 'prompt';
import Web3 from 'web3';
import Dharma from 'dharma';
import Wallet from './Wallet';
import ProviderEngine from 'web3-provider-engine';
import RpcSubprovider from 'web3-provider-engine/subproviders/rpc.js';
import Web3Subprovider from 'web3-provider-engine/subproviders/web3.js';
import Borrower from './Borrower';
import Authenticate from './Authenticate';
import commander from 'commander';
import inquirer from 'inquirer';
import Util from './Util';
import {WalletFlow, AuthenticateFlow} from './cli/prompts';
import {Spinner} from 'cli-spinner';
import {AuthenticationError} from './Errors';
import opn from 'opn';

class CLI {
  constructor(dharma, wallet) {
    this.dharma = dharma;
    this.web3 = dharma.web3;
    this.wallet = wallet;
    this.borrower = new Borrower(dharma);
  }

  static async authenticate(args) {
    let token;
    commander
      .version('0.1.0')
      .usage('authenticate <token>')
      .arguments('<token>')
      .action((_token) => {
        token = _token;
      });

    commander.parse(args);

    if (!token) {
      commander.help();
    }

    const authenticate = new Authenticate();

    try {
      await authenticate.setAuthKey(token);
      console.log("Your account is now authenticated!  You may broadcast requests "
        + 'to the Dharma Loan Network');
    } catch (err) {
      console.log(err);
      console.error("Failed to write to local authentication token store.");
    }
  }

  static entry(args) {
    commander
      .version('0.1.0')
      .command('borrow <amount>', "request an instant loan in Ether.")
      .command('authenticate <token>', "authenticate yourself in order to borrow.")
      .parse(args);
  }

  static async borrow(args) {
    let amount;
    commander
      .version('0.1.0')
      .usage('borrow [options] <amount>')
      .option('-u, --unit [unit]',
        'Specifies the unit of ether (e.g. wei, finney, szabo)',
        /^(wei|kwei|ada|mwei|babbage|gwei|shannon|szabo|finney|ether|kether|grand|einstein|mether|gether|tether|small)$/i,
        'ether')
      .arguments('<amount>')
      .action((_amount) => {
        amount = _amount;
      })

    commander.parse(args);

    if (!amount) {
      commander.help()
    }

    const cli = await CLI.init();
    await cli.borrowFlow(amount, commander.unit);
  }

  static async init(amount, unit) {
    const walletExists = await Wallet.walletExists();
    let wallet;
    if (walletExists) {
      wallet = await CLI.loadWalletFlow();
    } else {
      wallet = await CLI.generateWalletFlow()
    }

    const engine = new ProviderEngine();
    const web3 = new Web3(engine);

    engine.addProvider(wallet.getSubprovider());
    engine.addProvider(new Web3Subprovider(new Web3.providers.HttpProvider('http://localhost:8546')))
    engine.start();

    const dharma = new Dharma(web3);

    return new CLI(dharma, wallet);
  }

  static async loadWalletFlow() {
    const choice = await inquirer.prompt([WalletFlow.unlockOptions]);

    let wallet;
    if (choice.unlockChoice === 'Enter passphrase') {
      while (true) {
        const answer = await inquirer.prompt([WalletFlow.enterPassphrase]);

        try {
          wallet = await Wallet.getWallet(answer.passphrase);
          console.log("Wallet unlocked!");
          break;
        } catch (err) {
          console.error("Incorrect passphrase.  Please try again.");
        }
      }
    } else {
      while (true) {
        let {mnemonic} = await inquirer.prompt([WalletFlow.enterMnemonic]);

        try {
          wallet = await Wallet.recoverWallet(mnemonic);
          console.log("Wallet has been recovered!");
          break;
        } catch (err) {
          console.log(err)
          console.error("Incorrect seed phrase.  Please try again.");
        }
      }

      const passphrase = await this.passphraseFlow();
      await wallet.save(passphrase);

      console.log("Wallet saved and re-encrypted with new passphrase.")
    }

    return wallet;
  }

  static async passphraseFlow() {
    let passphrase;
    while (!passphrase) {
      let passphraseAnswers = await inquirer.prompt([
        WalletFlow.choosePassphrase, WalletFlow.confirmPassphrase
      ])

      if (passphraseAnswers.passphrase !== passphraseAnswers.passphraseConfirmation) {
        console.error("Confirmation does not match passphrase, try again.");
      } else {
        passphrase = passphraseAnswers.passphrase;
      }
    }

    return passphrase;
  }

  static async generateWalletFlow() {
    await inquirer.prompt([WalletFlow.start])

    const passphrase = await this.passphraseFlow();

    const wallet = await Wallet.generate(passphrase);

    const address = wallet.getAddress();
    const mnemonic = wallet.getMnemonic();

    console.log("You've generated a local wallet with the following address: " + address);
    console.log("Please write down the following recovery phrase and store it in " +
      "a safe place -- if you forget your passphrase, you will not be able to " +
      "recover your funds without the recovery phrase");
    console.log(mnemonic);

    return wallet;
  }

  async borrowFlow(amount, unit) {
    const address = this.wallet.getAddress();

    let loan;
    let stipendReceiptHash;

    const loader = new Spinner('Requesting attestation from Dharma Labs Inc.')
    loader.setSpinnerString(18);
    loader.start();

    // Request attestation from the Risk Assessment Attestor (i.e. Dharma)
    try {
      loan = await this.borrower.requestAttestation(address, amount);
    } catch (err) {
      loader.stop();
      if (err.type === 'AuthenticationError') {
        const answer = await inquirer.prompt([AuthenticateFlow.start]);
        if (answer.confirmStart) {
          await opn('http://localhost:8080/api/authenticate', { wait: false });
        }
      } else {
        throw err;
      }
      return;
    }

    // If borrower's balance is too low to deploy loan request, request deployment
    // stipend from RAA.
    const hasMinBalance = await this.borrower.hasMinBalanceRequired(address);
    if (!hasMinBalance) {
      loader.setSpinnerTitle("Requesting deployment stipend from Dharma Labs Inc.");
      try {
        const txHash = await this.borrower.requestDeploymentStipend(address);
        const tx = await Util.transactionMined(this.web3, txHash);
      } catch (err) {
        console.error(err.stack);
      }
    }

    loader.stop();
  }
}

module.exports = CLI;