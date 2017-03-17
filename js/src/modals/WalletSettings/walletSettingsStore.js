// Copyright 2015-2017 Parity Technologies (UK) Ltd.
// This file is part of Parity.

// Parity is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Parity is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with Parity.  If not, see <http://www.gnu.org/licenses/>.

import { noop } from 'lodash';
import { observable, computed, action, transaction } from 'mobx';
import BigNumber from 'bignumber.js';

import { validateUint, validateAddress } from '~/util/validation';
import { DEFAULT_GAS, MAX_GAS_ESTIMATION } from '~/util/constants';

const STEPS = {
  EDIT: { title: 'wallet settings' },
  CONFIRMATION: { title: 'confirmation' }
};

export default class WalletSettingsStore {
  accounts = {};
  onClose = noop;

  @observable fromString = false;
  @observable requests = [];
  @observable step = null;

  @observable wallet = {
    owners: null,
    require: null,
    dailylimit: null,
    sender: ''
  };

  @observable errors = {
    owners: null,
    require: null,
    dailylimit: null,
    sender: null
  };

  @computed get stage () {
    return this.stepsKeys.findIndex((k) => k === this.step);
  }

  @computed get hasErrors () {
    return !!Object.keys(this.errors).find((key) => !!this.errors[key]);
  }

  @computed get stepsKeys () {
    return this.steps.map((s) => s.key);
  }

  @computed get steps () {
    return Object
      .keys(STEPS)
      .map((key) => {
        return {
          ...STEPS[key],
          key
        };
      });
  }

  @action
  changesFromString (json) {
    try {
      const data = JSON.parse(json);
      const changes = data.map((datum) => {
        const [ type, valueStr ] = datum.split(';');

        let value = valueStr;

        // Only addresses start with `0x`, the others
        // are BigNumbers
        if (!/^0x/.test(valueStr)) {
          value = new BigNumber(valueStr, 16);
        }

        return { type, value };
      });

      this.changes = changes;
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        console.error('changes from string', error);
      }

      this.changes = [];
    }
  }

  changesToString () {
    const changes = this.changes.map((change) => {
      const { type, value } = change;

      const valueStr = (value && typeof value.plus === 'function')
        ? value.toString(16)
        : value;

      return [
        type,
        valueStr
      ].join(';');
    });

    return JSON.stringify(changes);
  }

  get changes () {
    const changes = [];

    const prevDailylimit = new BigNumber(this.initialWallet.dailylimit);
    const nextDailylimit = new BigNumber(this.wallet.dailylimit);

    const prevRequire = new BigNumber(this.initialWallet.require);
    const nextRequire = new BigNumber(this.wallet.require);

    if (!prevDailylimit.equals(nextDailylimit)) {
      changes.push({
        type: 'dailylimit',
        initial: prevDailylimit,
        value: nextDailylimit
      });
    }

    if (!prevRequire.equals(nextRequire)) {
      changes.push({
        type: 'require',
        initial: prevRequire,
        value: nextRequire
      });
    }

    const prevOwners = this.initialWallet.owners;
    const nextOwners = this.wallet.owners;

    const ownersToRemove = prevOwners.filter((owner) => !nextOwners.includes(owner));
    const ownersToAdd = nextOwners.filter((owner) => !prevOwners.includes(owner));

    ownersToRemove.forEach((owner) => {
      changes.push({
        type: 'remove_owner',
        value: owner
      });
    });

    ownersToAdd.forEach((owner) => {
      changes.push({
        type: 'add_owner',
        value: owner
      });
    });

    return changes;
  }

  set changes (changes) {
    transaction(() => {
      this.wallet.dailylimit = this.initialWallet.dailylimit;
      this.wallet.require = this.initialWallet.require;
      this.wallet.owners = this.initialWallet.owners.slice();

      changes.forEach((change) => {
        const { type, value } = change;

        switch (type) {
          case 'dailylimit':
            this.wallet.dailylimit = value;
            break;

          case 'require':
            this.wallet.require = value;
            break;

          case 'remove_owner':
            this.wallet.owners = this.wallet.owners.filter((owner) => owner !== value);
            break;

          case 'add_owner':
            this.wallet.owners.push(value);
            break;
        }
      });
    });
  }

  constructor (api, props) {
    const { onClose, wallet } = props;

    this.api = api;
    this.step = this.stepsKeys[0];

    this.walletInstance = wallet.instance;

    this.initialWallet = {
      address: wallet.address,
      owners: wallet.owners,
      require: wallet.require,
      dailylimit: wallet.dailylimit.limit
    };

    transaction(() => {
      this.wallet.owners = wallet.owners;
      this.wallet.require = wallet.require;
      this.wallet.dailylimit = wallet.dailylimit.limit;

      this.validateWallet(this.wallet);
    });

    this.onClose = onClose;
  }

  @action onNext = () => {
    const stepIndex = this.stepsKeys.findIndex((k) => k === this.step) + 1;

    this.step = this.stepsKeys[stepIndex];
  }

  @action onChange = (_wallet) => {
    const newWallet = Object.assign({}, this.wallet, _wallet);

    this.validateWallet(newWallet);
  }

  @action onOwnersChange = (owners) => {
    this.onChange({ owners });
  }

  @action onRequireChange = (require) => {
    this.onChange({ require });
  }

  @action onSenderChange = (_, sender) => {
    this.onChange({ sender });
  }

  @action onDailylimitChange = (dailylimit) => {
    this.onChange({ dailylimit });
  }

  @action onModificationsStringChange = (event, value) => {
    this.changesFromString(value);

    if (this.changes && this.changes.length > 0) {
      this.fromString = true;
    } else {
      this.fromString = false;
    }
  }

  @action send = () => {
    const changes = this.changes;
    const walletInstance = this.walletInstance;

    Promise.all(changes.map((change) => this.sendChange(change, walletInstance)));
    this.onClose();
  }

  @action sendChange = (change, walletInstance) => {
    const { method, values } = this.getChangeMethod(change, walletInstance);

    const options = {
      from: this.wallet.sender,
      to: this.initialWallet.address,
      gas: MAX_GAS_ESTIMATION
    };

    return method
      .estimateGas(options, values)
      .then((gasEst) => {
        let gas = gasEst;

        if (gas.gt(DEFAULT_GAS)) {
          gas = gas.mul(1.2);
        }
        options.gas = gas;

        return method.postTransaction(options, values);
      });
  }

  getChangeMethod = (change, walletInstance) => {
    if (change.type === 'require') {
      return {
        method: walletInstance.changeRequirement,
        values: [ change.value ]
      };
    }

    if (change.type === 'dailylimit') {
      return {
        method: walletInstance.setDailyLimit,
        values: [ change.value ]
      };
    }

    if (change.type === 'add_owner') {
      return {
        method: walletInstance.addOwner,
        values: [ change.value ]
      };
    }

    if (change.type === 'remove_owner') {
      return {
        method: walletInstance.removeOwner,
        values: [ change.value ]
      };
    }
  }

  @action validateWallet = (_wallet) => {
    const senderValidation = validateAddress(_wallet.sender);
    const requireValidation = validateUint(_wallet.require);
    const dailylimitValidation = validateUint(_wallet.dailylimit);

    const errors = {
      sender: senderValidation.addressError,
      require: requireValidation.valueError,
      dailylimit: dailylimitValidation.valueError
    };

    const wallet = {
      ..._wallet,
      sender: senderValidation.address,
      require: requireValidation.value,
      dailylimit: dailylimitValidation.value
    };

    transaction(() => {
      this.wallet = wallet;
      this.errors = errors;
    });
  }
}
