/**
 * @file Contracts
 * @description Core DI interfaces for decoupling extension layers.
 */

export type { ISettings } from './Settings';

export interface IView {
	postMessage(message: unknown): void;
}
