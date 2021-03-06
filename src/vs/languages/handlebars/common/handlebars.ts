/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import modes = require('vs/editor/common/modes');
import htmlMode = require('vs/languages/html/common/html');
import handlebarsTokenTypes = require('vs/languages/handlebars/common/handlebarsTokenTypes');
import htmlWorker = require('vs/languages/html/common/htmlWorker');
import {IInstantiationService} from 'vs/platform/instantiation/common/instantiation';
import {IModeService} from 'vs/editor/common/services/modeService';
import {LanguageConfigurationRegistry, LanguageConfiguration} from 'vs/editor/common/modes/languageConfigurationRegistry';
import {createWordRegExp} from 'vs/editor/common/modes/abstractMode';
import {wireCancellationToken} from 'vs/base/common/async';
import {ICompatWorkerService} from 'vs/editor/common/services/compatWorkerService';
import {IWorkspaceContextService} from 'vs/platform/workspace/common/workspace';
import {IConfigurationService} from 'vs/platform/configuration/common/configuration';
import {TokenizationSupport, ILeavingNestedModeData} from 'vs/editor/common/modes/supports/tokenizationSupport';

export enum States {
	HTML,
	Expression,
	UnescapedExpression
}

export class HandlebarsState extends htmlMode.State {

	constructor(modeId:string,
		kind:htmlMode.States,
		public handlebarsKind:States,
		lastTagName:string,
		lastAttributeName:string,
		embeddedContentType:string,
		attributeValueQuote:string,
		attributeValueLength:number) {

		super(modeId, kind, lastTagName, lastAttributeName, embeddedContentType, attributeValueQuote, attributeValueLength);
	}

	public makeClone(): HandlebarsState {
		return new HandlebarsState(this.getModeId(), this.kind, this.handlebarsKind, this.lastTagName, this.lastAttributeName, this.embeddedContentType, this.attributeValueQuote, this.attributeValueLength);
	}

	public equals(other:modes.IState):boolean {
		if (other instanceof HandlebarsState) {
			return (
				super.equals(other)
			);
		}
		return false;
	}

	public tokenize(stream:modes.IStream) : modes.ITokenizationResult {
		switch(this.handlebarsKind) {
			case States.HTML:
				if (stream.advanceIfString('{{{').length > 0) {
					this.handlebarsKind = States.UnescapedExpression;
					return { type: handlebarsTokenTypes.EMBED_UNESCAPED };
				}
				else if (stream.advanceIfString('{{').length > 0) {
					this.handlebarsKind = States.Expression;
					return { type: handlebarsTokenTypes.EMBED };
				}
			break;

			case States.Expression:
			case States.UnescapedExpression:
				if (this.handlebarsKind === States.Expression && stream.advanceIfString('}}').length > 0) {
					this.handlebarsKind = States.HTML;
					return { type: handlebarsTokenTypes.EMBED };
				}
				else if (this.handlebarsKind === States.UnescapedExpression &&stream.advanceIfString('}}}').length > 0) {
					this.handlebarsKind = States.HTML;
					return { type: handlebarsTokenTypes.EMBED_UNESCAPED };
				}
				else if(stream.skipWhitespace().length > 0) {
					return { type: ''};
				}

				if(stream.peek() === '#') {
					stream.advanceWhile(/^[^\s}]/);
					return { type: handlebarsTokenTypes.KEYWORD };
				}

				if(stream.peek() === '/') {
					stream.advanceWhile(/^[^\s}]/);
					return { type: handlebarsTokenTypes.KEYWORD };
				}

				if(stream.advanceIfString('else')) {
					var next = stream.peek();
					if(next === ' ' || next === '\t' || next === '}') {
						return { type: handlebarsTokenTypes.KEYWORD };
					}
					else {
						stream.goBack(4);
					}
				}

				if(stream.advanceWhile(/^[^\s}]/).length > 0) {
					return { type: handlebarsTokenTypes.VARIABLE };
				}
			break;
		}
		return super.tokenize(stream);
	}
}

export class HandlebarsMode extends htmlMode.HTMLMode<htmlWorker.HTMLWorker> {

	public static LANG_CONFIG:LanguageConfiguration = {
		wordPattern: createWordRegExp('#-?%'),

		comments: {
			blockComment: ['<!--', '-->']
		},

		brackets: [
			['<!--', '-->'],
			['{{', '}}']
		],

		__electricCharacterSupport: {
			embeddedElectricCharacters: ['*', '}', ']', ')']
		},

		autoClosingPairs: [
			{ open: '{', close: '}' },
			{ open: '[', close: ']' },
			{ open: '(', close: ')' },
			{ open: '"', close: '"' },
			{ open: '\'', close: '\'' }
		],

		surroundingPairs: [
			{ open: '<', close: '>' },
			{ open: '"', close: '"' },
			{ open: '\'', close: '\'' }
		],

		onEnterRules: [
			{
				beforeText: new RegExp(`<(?!(?:${htmlMode.EMPTY_ELEMENTS.join('|')}))(\\w[\\w\\d]*)([^/>]*(?!/)>)[^<]*$`, 'i'),
				afterText: /^<\/(\w[\w\d]*)\s*>$/i,
				action: { indentAction: modes.IndentAction.IndentOutdent }
			},
			{
				beforeText: new RegExp(`<(?!(?:${htmlMode.EMPTY_ELEMENTS.join('|')}))(\\w[\\w\\d]*)([^/>]*(?!/)>)[^<]*$`, 'i'),
				action: { indentAction: modes.IndentAction.Indent }
			}
		],
	};

	constructor(
		descriptor:modes.IModeDescriptor,
		@IInstantiationService instantiationService: IInstantiationService,
		@IModeService modeService: IModeService,
		@ICompatWorkerService compatWorkerService: ICompatWorkerService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super(descriptor, instantiationService, modeService, compatWorkerService, workspaceContextService, configurationService);
	}

	protected _registerSupports(): void {
		modes.SuggestRegistry.register(this.getId(), {
			triggerCharacters: ['.', ':', '<', '"', '=', '/'],
			provideCompletionItems: (model, position, token): Thenable<modes.ISuggestResult> => {
				return wireCancellationToken(token, this._provideCompletionItems(model.uri, position));
			}
		}, true);

		modes.DocumentHighlightProviderRegistry.register(this.getId(), {
			provideDocumentHighlights: (model, position, token): Thenable<modes.DocumentHighlight[]> => {
				return wireCancellationToken(token, this._provideDocumentHighlights(model.uri, position));
			}
		}, true);

		modes.LinkProviderRegistry.register(this.getId(), {
			provideLinks: (model, token): Thenable<modes.ILink[]> => {
				return wireCancellationToken(token, this.provideLinks(model.uri));
			}
		}, true);

		LanguageConfigurationRegistry.register(this.getId(), HandlebarsMode.LANG_CONFIG);

		modes.TokenizationRegistry.register(this.getId(), new TokenizationSupport(this._modeService, this.getId(), this, true));
	}

	public getInitialState() : modes.IState {
		return new HandlebarsState(this.getId(), htmlMode.States.Content, States.HTML, '', '', '', '', 0);
	}

	public getLeavingNestedModeData(line:string, state:modes.IState):ILeavingNestedModeData {
		var leavingNestedModeData = super.getLeavingNestedModeData(line, state);
		if (leavingNestedModeData) {
			leavingNestedModeData.stateAfterNestedMode = new HandlebarsState(this.getId(), htmlMode.States.Content, States.HTML, '', '', '', '', 0);
		}
		return leavingNestedModeData;
	}
}
