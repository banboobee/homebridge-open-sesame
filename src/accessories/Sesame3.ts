import { Mutex } from "async-mutex";
import { hostname } from "os";
import {
  APIEvent,
  Service,
  PlatformAccessory,
  CharacteristicValue,
  CharacteristicChange,
} from "homebridge";

import { CandyClient } from "../CandyClient";
import { CognitoClient } from "../CognitoClient";
import * as Util from "../Util";
import { Client } from "../interfaces/Client";
import { OpenSesame } from "../platform";
import { PLATFORM_NAME } from "../settings";
import { CHSesame2MechStatus } from "../types/API";
import { Command } from "../types/Command";
import { CHDevice } from "../types/Device";

export class Sesame3 {
  readonly #client: Client;
  readonly #mutex: Mutex;

  readonly #lockService: Service;
  readonly #batteryService: Service;
  
  #historyService: any = null;

  constructor(
    private readonly platform: OpenSesame,
    private readonly accessory: PlatformAccessory,
    private readonly sesame: CHDevice,
  ) {
    if (
      typeof this.platform.config.clientID != "undefined" &&
      this.platform.config.clientID != ""
    ) {
      this.platform.log.debug("CLIENT_ID is deteted. Using CognitoClient");

      this.#client = new CognitoClient(
        Sesame3,
        this.sesame,
        this.platform.config.apiKey,
        this.platform.config.clientID,
        this.platform.log,
      );
    } else {
      this.platform.log.debug("CLIENT_ID is not deteted. Using CandyClient");

      this.#client = new CandyClient(
        this.sesame,
        this.platform.config.apiKey,
        this.platform.config.interval ?? 60 * 60,
        this.platform.log,
      );
    }

    this.platform.api.on(APIEvent.SHUTDOWN, () => {
      this.#client.shutdown();
    });

    this.#mutex = new Mutex();

    this.accessory
      .getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, PLATFORM_NAME)
      .setCharacteristic(platform.Characteristic.Model, "Sesame3")
      .setCharacteristic(platform.Characteristic.SerialNumber, sesame.uuid);

    this.#lockService =
      this.accessory.getService(platform.Service.LockMechanism) ??
      this.accessory.addService(platform.Service.LockMechanism);

    const name = this.sesame.name ?? this.sesame.uuid;
    this.#lockService.setCharacteristic(platform.Characteristic.Name, name);

    this.#lockService
      .getCharacteristic(platform.Characteristic.LockCurrentState)
      .onGet(this.getLockState.bind(this));

    this.#lockService
      .getCharacteristic(platform.Characteristic.LockTargetState)
      .onGet(this.getLockState.bind(this))
      .onSet(this.setLockTargetState.bind(this));

    this.#batteryService =
      this.accessory.getService(platform.Service.Battery) ??
      this.accessory.addService(platform.Service.Battery);
    this.#batteryService
      .getCharacteristic(platform.Characteristic.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this));
    this.#batteryService
      .getCharacteristic(platform.Characteristic.StatusLowBattery)
      .onGet(this.getStatusLowBattery.bind(this));

    // Start updating status
    //this.updateToLatestStatus();	// any reason to fire before initialization?
    //this.subscribe();

    this.platform.log.debug(
      `${this.accessory.displayName} history: ${this.sesame?.history}, context: {lockState:${this.accessory.context.lockState}, batteryLevel:${this.accessory.context.batteryLevel}, batteryCritical:${this.accessory.context.batteryCritical}, timesOpened:${this.accessory.context.timesOpened}, lastReset:${this.accessory.context.lastReset}}`
    );

    // Initialize accessory characteristics
    this.accessory.context.lockState ??= platform.Characteristic.LockCurrentState.SECURED;
    this.accessory.context.batteryLevel ??= 100;
    this.accessory.context.batteryCritical ??= false;
    this.accessory.context.timesOpened ??= 0;
    this.accessory.context.lastReset ??= 0;

    // Setup EVE history features
    if (this.sesame?.history == true) {
      this.setupHistoryService();	// want to await but disallowed.
    } else {
      // discards cached values if history is turned off
      this.accessory.context.batteryLevel = 100;
      this.accessory.context.batteryCritical = false;
      this.accessory.context.timesOpened = undefined;
      this.accessory.context.lastReset = undefined;
    }

    // Start updating status
    this.updateToLatestStatus();	// moved to update after initialization.
    this.subscribe();
  }

  /*
   * Setup EVE history features for lock devices.
   */
  private async setupHistoryService(): Promise<void> {
    const sensor: Service =
      this.accessory.getService(this.platform.Service.ContactSensor) ??
      this.accessory.addService(this.platform.Service.ContactSensor, `${this.accessory.displayName} Contact`);
    this.#historyService = new this.platform.fakegatoAPI('door', this.accessory,
      {log: this.platform.HBLog, storage: 'fs',
       filename: `${hostname().split(".")[0]}_${this.accessory.displayName}_persist.json`
      });
    sensor.addOptionalCharacteristic(this.platform.eve.Characteristics.OpenDuration);
    sensor.getCharacteristic(this.platform.eve.Characteristics.OpenDuration)
      .onGet(() => 0);
    sensor.addOptionalCharacteristic(this.platform.eve.Characteristics.ClosedDuration);
    sensor.getCharacteristic(this.platform.eve.Characteristics.ClosedDuration)
      .onGet(() => 0);
    sensor.addOptionalCharacteristic(this.platform.eve.Characteristics.TimesOpened);
    sensor.getCharacteristic(this.platform.eve.Characteristics.TimesOpened)
      .onGet(() => this.accessory.context.timesOpened);
    sensor.addOptionalCharacteristic(this.platform.eve.Characteristics.LastActivation);
    sensor.getCharacteristic(this.platform.eve.Characteristics.LastActivation)
      .onGet(() => {
	const lastActivation = this.accessory.context.lastActivation ?
	      Math.max(0, this.accessory.context.lastActivation - this.#historyService.getInitialTime()) : 0;
	//this.platform.log.debug(`Get LastActivation ${this.accessory.displayName}: ${lastActivation}`);
	return lastActivation;
      });
    sensor.addOptionalCharacteristic(this.platform.eve.Characteristics.ResetTotal);
    sensor.getCharacteristic(this.platform.eve.Characteristics.ResetTotal)
      .onSet((reset: CharacteristicValue) => {
	const sensor = this.accessory.getService(this.platform.Service.ContactSensor);
        this.accessory.context.timesOpened = 0;
        this.accessory.context.lastReset = reset;
        sensor?.updateCharacteristic(this.platform.eve.Characteristics.TimesOpened, 0);
        this.platform.log.debug(`${this.accessory.displayName}: Reset TimesOpened to 0`);
        this.platform.log.debug(`${this.accessory.displayName}: Set lastReset to ${reset}`);
      })
      .onGet(() => {
	return this.accessory.context.lastReset ??
	  (this.#historyService.getInitialTime() - Math.round(Date.parse('01 Jan 2001 00:00:00 GMT')/1000));
      });
    sensor.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .on('change', (event: CharacteristicChange) => {
	if (event.newValue !== event.oldValue) {
	  this.platform.log.debug(`${this.accessory.displayName}: ContactSensor state on change: ${JSON.stringify(event)}`);
	  const sensor = this.accessory.getService(this.platform.Service.ContactSensor);
          const entry = {
            time: Math.round(new Date().valueOf()/1000),
            status: event.newValue
          };
          this.accessory.context.lastActivation = entry.time;
            sensor?.updateCharacteristic(this.platform.eve.Characteristics.LastActivation, Math.max(0, this.accessory.context.lastActivation - this.#historyService.getInitialTime()));
          if (entry.status) {
            this.accessory.context.timesOpened++;
            sensor?.updateCharacteristic(this.platform.eve.Characteristics.TimesOpened, this.accessory.context.timesOpened);
          }
          this.#historyService.addEntry(entry);
	}
      });
    await this.updateHistory();
  }

  private async updateHistory() : Promise<void>{
    const state =
	  this.accessory.context.lockState === this.platform.Characteristic.LockCurrentState.SECURED ?
	  this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED :
	  this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    this.#historyService.addEntry ({
      time: Math.round(new Date().valueOf()/1000),
      status: state
    });
    setTimeout(() => {
      this.updateHistory();
    }, 10 * 60 * 1000);
  }

  private getBatteryLevel(): CharacteristicValue {
    return this.accessory.context.batteryLevel;
  }

  private getStatusLowBattery(): CharacteristicValue {
    return this.accessory.context.batteryCritical;
  }

  private getLockState(): CharacteristicValue {
    return this.accessory.context.lockState;
  }

  private updateContactSensorState() {
    const sensor = this.accessory.getService(this.platform.Service.ContactSensor);
    if (sensor) {
      const state =
        this.accessory.context.lockState === this.platform.Characteristic.LockCurrentState.SECURED ?
        this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED :
        this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
      sensor.getCharacteristic(this.platform.Characteristic.ContactSensorState)
	.updateValue(state);
    }
  }

  private get isWebAPIMode(): boolean {
    return this.#client instanceof CandyClient;
  }

  private async setLockTargetState(value: CharacteristicValue) {
    const deviceName = this.sesame.name ?? this.sesame.uuid;

    let cmd: number;
    switch (value) {
      case this.platform.Characteristic.LockCurrentState.SECURED:
        cmd = Command.lock;
        this.platform.log.info(
          `Sending request for ${deviceName} to API. cmd: locked(${cmd})`,
        );
        break;
      case this.platform.Characteristic.LockCurrentState.UNSECURED:
        cmd = Command.unlock;
        this.platform.log.info(
          `Sending request for ${deviceName} to API. cmd: unlocked(${cmd})`,
        );
        break;
      default:
        return;
    }

    try {
      await this.#mutex.runExclusive(async () => {
        this.#lockService
          .getCharacteristic(this.platform.Characteristic.LockTargetState)
          .updateValue(value);

        await this.#client.postCmd(cmd, this.platform.config.name);

        // Using CognitoClient, we don't need update manually.
        // Updating status will be done by mqtt subscription.
        // While CandyClient delays until next updateStatus occurs.
        // So, update status for CandyClient only.
        if (this.isWebAPIMode) {
          // Adjust update timing
          await Util.sleep(2.5 * 1000);

          // Update state
          this.updateToLatestStatus();
        }
      });
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`${deviceName} - ${error.message}`);
      }
      this.platform.log.debug(`${error}`);

      // Mark as jammed
      this.#lockService
        .getCharacteristic(this.platform.Characteristic.LockCurrentState)
        .updateValue(this.platform.Characteristic.LockCurrentState.JAMMED);
    }
  }

  private setLockStatus(status: CHSesame2MechStatus): void {
    // locked xor unlocked
    if (status.isInLockRange === status.isInUnlockRange) {
      return;
    }

    const currentLockState = this.accessory.context.lockState;
    const newLockState = status.isInLockRange
      ? this.platform.Characteristic.LockCurrentState.SECURED
      : this.platform.Characteristic.LockCurrentState.UNSECURED;

    if (newLockState === currentLockState) {
      return;
    }

    const logPrefix = this.sesame.name ?? this.sesame.uuid;
    this.platform.log.info(
      `${logPrefix} - Current state: ${newLockState ? "Locked" : "Unlocked"}`,
    );

    this.accessory.context.lockState = newLockState;
    this.accessory.context.batteryLevel = status.batteryPercentage;
    this.accessory.context.batteryCritical = status.isBatteryCritical;

    // Update lock service
    this.#lockService
      .getCharacteristic(this.platform.Characteristic.LockTargetState)
      .updateValue(this.getLockState());
    this.#lockService
      .getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .updateValue(this.getLockState());

    // Update battery service
    this.#batteryService
      .getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .updateValue(this.getBatteryLevel());
    this.#batteryService
      .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .updateValue(this.getStatusLowBattery());

    // Update contact sensor state
    this.updateContactSensorState();
  }

  private async updateToLatestStatus(): Promise<void> {
    const status = await this.#client.getMechStatus();
    if (typeof status !== "undefined") {
      this.setLockStatus(status);
    }
  }

  private async subscribe() {
    this.#client.subscribe((status: CHSesame2MechStatus) => {
      this.setLockStatus(status);
    });
  }
}
