import { combineEpics } from 'redux-observable';
import { filter, map, mergeMap, switchMap, tap } from 'rxjs/operators';
import { from } from 'rxjs';
import { Action, isType } from 'redux-typescript-actions';
import { actions } from '../actions';
import { INotepadStoreState } from '../types/NotepadTypes';
import { dataURItoBlob, generateGuid, isAction } from '../util';
import saveAs from 'save-as';
import { ASSET_STORAGE } from '../index';
import { NewNotepadObjectAction, UpdateElementAction } from '../types/ActionTypes';
import { IStoreState } from '../types';
import { Asset, FlatNotepad, Note } from 'upad-parse/dist/index';
import { NoteElement } from 'upad-parse/dist/Note';
import { Store } from 'redux';

const loadNote$ = (action$, store) =>
	action$.pipe(
		filter((action: Action<string>) => isType(action, actions.loadNote.started)),
		map((action: Action<string>) => [action.payload, { ...(store.getState().notepads.notepad || <INotepadStoreState> {}).item }]),
		filter(([ref, notepad]: [string, FlatNotepad]) => !!ref && !!notepad),
		map(([ref, notepad]: [string, FlatNotepad]) => notepad.notes[ref]),
		filter(Boolean),
		mergeMap((note: Note) => [actions.expandFromNote({
			note,
			notepad: (store.getState() as IStoreState).notepads.notepad!.item!
		}), actions.checkNoteAssets.started([note.internalRef, note.elements])])
	);

const checkNoteAssets$ = (action$, store) =>
	action$.pipe(
		filter((action: Action<[string, NoteElement[]]>) => isType(action, actions.checkNoteAssets.started)),
		map((action: Action<[string, NoteElement[]]>) => action.payload),
		switchMap(([ref, elements]) =>
			from(getNoteAssets(elements))
				.pipe(map((res) => [ref, res.elements, res.blobUrls]))
		),
		map(([ref, elements, blobUrls]) => [ref, elements, blobUrls, (store.getState().notepads.notepad || <INotepadStoreState> {}).item]),
		filter(([ref, elements, blobUrls, notepad]) => !!notepad),
		mergeMap(([ref, elements, blobUrls, notepad]: [string, NoteElement[], object, FlatNotepad]) => {
			let newNotepad = notepad.clone({
				notes: {
					...notepad.notes,
					[ref]: notepad.notes[ref].clone({ elements })
				}
			});

			const notepadAssets: Set<string> = new Set(notepad.notepadAssets);
			elements.forEach(element => {
				if (element.content === 'AS') {
					notepadAssets.add(element.args.ext!);
				}
			});
			newNotepad.clone({ notepadAssets: Array.from(notepadAssets) });

			return [
				actions.checkNoteAssets.done({ params: <any> [], result: newNotepad }),
				actions.loadNote.done({ params: ref, result: blobUrls })
			];
		})
	);

const downloadAsset$ = action$ =>
	action$.pipe(
		filter((action: Action<{ filename: string, uuid: string }>) => isType(action, actions.downloadAsset.started)),
		map((action: Action<{ filename: string, uuid: string }>) => action.payload),
		switchMap(({filename, uuid}: { filename: string, uuid: string }) =>
			from(ASSET_STORAGE.getItem(uuid))
				.pipe(
					map((blob: Blob) => [blob, filename])
				)
		),
		filter(Boolean),
		tap(([blob, filename]: [Blob, string]) => saveAs(blob, filename)),
		map(([blob, filename]: [Blob, string]) => actions.downloadAsset.done({ params: { filename, uuid: '' }, result: undefined }))
	);

const binaryElementUpdate$ = action$ =>
	action$.pipe(
		isAction(actions.updateElement),
		map((action: Action<UpdateElementAction>) => action.payload),
		filter((params: UpdateElementAction) => !!params.newAsset),
		switchMap((params: UpdateElementAction) =>
			from(
				ASSET_STORAGE.setItem(params.element.args.ext || generateGuid(), params.newAsset)
					.then(() => [params, params.element.args.ext || generateGuid()])
			)
		),
		mergeMap(([params, guid]: [UpdateElementAction, string]) => [
			actions.trackAsset(guid),
			actions.updateElement({
				elementId: params.elementId,
				noteRef: params.noteRef,
				element: {
					...params.element,
					content: 'AS',
					args: {
						...params.element.args,
						ext: guid
					}
				}
			}),
			actions.reloadNote(undefined)
		])
	);

const reloadNote$ = (action$, store) =>
	action$.pipe(
		isAction(actions.reloadNote),
		map(() => store.getState()),
		map((state: IStoreState) => state.currentNote.ref),
		filter((noteRef: string) => !!noteRef && noteRef.length > 0),
		map((noteRef: string) => actions.loadNote.started(noteRef))

	);

const autoLoadNewNote$ = (action$, store) =>
	action$.pipe(
		isAction(actions.newNote),
		map((action: Action<NewNotepadObjectAction>) => [action.payload, (<IStoreState> store.getState()).notepads.notepad!.item]),
		filter(([insertAction, notepad]: [NewNotepadObjectAction, FlatNotepad]) => !!insertAction && !!insertAction.parent && !!notepad),
		map(([insertAction, notepad]: [NewNotepadObjectAction, FlatNotepad]) =>
			// Get a note with the new title that is in the expected parent
			Object.values((notepad as FlatNotepad).notes).find(n => n.parent === insertAction.parent && n.title === insertAction.title)
		),
		filter(Boolean),
		map((newNote: Note) => actions.loadNote.started(newNote.internalRef))
	);

const closeNoteOnDeletedParent$ = (action$, store: Store<IStoreState>) =>
	action$.pipe(
		isAction(actions.deleteNotepadObject),
		map(() => store.getState().notepads.notepad),
		filter(Boolean),
		map((notepadState: INotepadStoreState) => notepadState.item),

		// Has the currently opened note been deleted?
		filter((notepad: FlatNotepad) => store.getState().currentNote.ref.length > 0 && !notepad.notes[store.getState().currentNote.ref]),
		map(() => actions.closeNote(undefined))
	);

export const noteEpics$ = combineEpics(
	loadNote$,
	checkNoteAssets$,
	downloadAsset$,
	binaryElementUpdate$,
	reloadNote$,
	autoLoadNewNote$,
	closeNoteOnDeletedParent$
);

function getNoteAssets(elements: NoteElement[]): Promise<{ elements: NoteElement[], blobUrls: object }> {
	const storageRequests: Promise<Blob>[] = [];
	const blobRefs: string[] = [];

	elements.map(element => {
		if (element.type !== 'markdown' && element.content !== 'AS') {
			const asset = new Asset(dataURItoBlob(element.content));
			storageRequests.push(ASSET_STORAGE.setItem(asset.uuid, asset.data));
			blobRefs.push(asset.uuid);

			return { ...element, args: { ...element.args, ext: asset.uuid }, content: 'AS' };
		}

		if (!!element.args.ext) {
			storageRequests.push(ASSET_STORAGE.getItem(element.args.ext));
			blobRefs.push(element.args.ext);
		}

		return element;
	});

	return new Promise(resolve =>
		Promise.all(storageRequests)
			.then((blobs: Blob[]) => {
				const blobUrls = {};
				blobs.filter(b => !!b).forEach((blob, i) => blobUrls[blobRefs[i]] = URL.createObjectURL(blob));

				resolve({
					elements,
					blobUrls
				});
			})
	);
}
