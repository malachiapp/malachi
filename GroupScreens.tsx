/**
 * Malachi – GroupScreens.tsx
 *
 * Gruppenliste, "Neue Gruppe" und Gruppeninfo (vorher in App.tsx, Phase 0/1
 * nur lokal). Seit den echten Gruppenchats (GroupMessaging.js,
 * GROUP_CHAT_DESIGN.md) wirkt jede Aenderung ueber die verschluesselten 1:1-
 * Kanaele auf alle direkt gekoppelten Mitglieder. Farben kommen als Props aus
 * App.tsx (palette = P, accent = AC), damit Farbthemen an einer Stelle bleiben.
 */
import React from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Image, ScrollView, Alert, Modal,
  StyleSheet, I18nManager,
} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {
  GROUP_MAX_MEMBERS, memberIdOfContact, resolveGroupMembers, unreachableMembers,
  updateGroupInfo, addGroupMembers, removeGroupMember, leaveGroup, deleteGroupLocally,
  setGroupAvatarLocal,
} from './GroupMessaging';
import { t, formatTime, formatDate } from './i18n';

export const DEFAULT_PALETTE = {
  bg: '#04182F', surface: '#0D2A4A', surfaceAlt: '#0A2340', border: '#1B3A5C',
  text: '#F0F6FA', textSub: '#9FB8CC', textMuted: '#6E93AE', green: '#0A7EA4',
  avatarBg: '#0A2340', avatarText: '#3695B4', headerAvatarBg: '#0A2340', headerAvatarText: '#3695B4',
};
const DANGER = '#E74C3C';
const WARN = '#E0A33A';

export const gs = StyleSheet.create({
  header: { flexDirection:'row', justifyContent:'space-between', alignItems:'center',
            paddingHorizontal:16, paddingTop:16, paddingBottom:12, borderBottomWidth:0.5 },
  title:  { fontSize:22, fontWeight:'600' },
  row:    { flexDirection:'row', alignItems:'center', paddingHorizontal:16, paddingVertical:12 },
  badge:  { minWidth:20, height:20, borderRadius:10, paddingHorizontal:5, alignItems:'center', justifyContent:'center' },
});

// Gruppenbild bzw. Platzhalter: dieselben Design-Farben wie die Profilbilder
// der Kontakte (vorher weisses Symbol auf dem Akzent - auf hellen Akzenten
// wie Eisblau oder Lavendel kaum zu sehen).
export function GroupAvatar({ group, size = 44, accent = DEFAULT_PALETTE.green, palette = DEFAULT_PALETTE, onHeader = false }) {
  const bg = (onHeader ? palette.headerAvatarBg : palette.avatarBg) || palette.surfaceAlt;
  const fg = (onHeader ? palette.headerAvatarText : palette.avatarText) || accent;
  if (group?.avatarUri) {
    return <Image source={{ uri: group.avatarUri }} style={{ width:size, height:size, borderRadius:size/2, backgroundColor:bg }} resizeMode="cover" />;
  }
  return (
    <View style={{ width:size, height:size, borderRadius:size/2, backgroundColor:bg,
      alignItems:'center', justifyContent:'center' }}>
      <Icon name="users" size={size*0.5} color={fg} />
    </View>
  );
}

// Kleines Mitglieds-Bild: Profilbild/Initialen des Kontakts, sonst Initialen
// aus dem Namen in den Gruppendaten (nicht gekoppelte Mitglieder).
export function MemberAvatar({ contact, name, size = 36, palette = DEFAULT_PALETTE }) {
  const bg = palette.avatarBg || palette.surfaceAlt;
  if (contact?.theirAvatar) {
    return <Image source={{ uri: contact.theirAvatar }} style={{ width:size, height:size, borderRadius:size/2, backgroundColor:bg }} resizeMode="cover" />;
  }
  const initials = String(contact?.name || name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => Array.from(w)[0] || '').join('').toUpperCase() || contact?.initials || '?';
  return (
    <View style={{ width:size, height:size, borderRadius:size/2, backgroundColor:bg,
      alignItems:'center', justifyContent:'center' }}>
      <Text style={{ fontSize:size*0.38, fontWeight:'600', color: palette.avatarText || palette.textSub }}>{initials}</Text>
    </View>
  );
}

export function formatGroupTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatTime(d);
  return formatDate(d, { day:'2-digit', month:'2-digit' });
}

// Kopfleiste in den Design-Farben (Themes.js: headerBg/headerText/...), mit
// Rueckfall auf die alte Palette ohne diese Tokens.
function Header({ title, onBack, right, palette }) {
  return (
    <View style={[gs.header, { backgroundColor:palette.headerBg || palette.surface, borderBottomColor:palette.headerBorder || palette.border }]}>
      <View style={{ flexDirection:'row', alignItems:'center', gap:8, flexShrink:1 }}>
        <TouchableOpacity onPress={onBack} style={{ padding:4 }}>
          <Icon name={I18nManager.isRTL ? 'arrow-right' : 'arrow-left'} size={22} color={palette.headerText || palette.text} />
        </TouchableOpacity>
        <Text style={[gs.title, { color:palette.headerText || palette.text, flexShrink:1 }]} numberOfLines={1}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

// ─── Gruppenliste ───────────────────────────────────────────────────────────
export function GroupsScreen({ groups, onBack, onCreate, onOpenGroup, palette = DEFAULT_PALETTE, accent = DEFAULT_PALETTE.green }) {
  const sorted = React.useMemo(() => [...(groups || [])].sort((a, b) =>
    (b.lastTime || b.createdAt || 0) - (a.lastTime || a.createdAt || 0)), [groups]);
  return (
    <View style={{ flex:1, backgroundColor:palette.bg }}>
      <Header title={t('common.groups')} onBack={onBack} palette={palette}
        right={(
          <TouchableOpacity onPress={onCreate} style={{ padding:4 }}>
            <Icon name="plus" size={22} color={accent} />
          </TouchableOpacity>
        )} />
      <FlatList data={sorted} keyExtractor={g => g.groupId}
        contentContainerStyle={{ paddingVertical:8 }}
        ListEmptyComponent={
          <View style={{ padding:32, alignItems:'center' }}>
            <Text style={{ color:palette.textMuted, fontSize:13, textAlign:'center' }}>
              {t('groups.empty')}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const count = (item.members?.length || ((item.memberContactIds?.length || 0) + 1));
          const sub = item.removed ? t('groups.notMember')
            : item.last ? item.last
            : t('groups.memberCount', { count });
          return (
            <TouchableOpacity style={gs.row} onPress={() => onOpenGroup(item)} activeOpacity={0.7}>
              <GroupAvatar group={item} accent={accent} palette={palette} />
              <View style={{ marginLeft:12, flex:1, minWidth:0 }}>
                <View style={{ flexDirection:'row', alignItems:'center' }}>
                  <Text style={{ fontSize:15, fontWeight:'500', color:palette.text, flex:1 }} numberOfLines={1}>{item.name}</Text>
                  {!!item.lastTime && <Text style={{ fontSize:11, color: item.unread ? accent : palette.textMuted, marginLeft:8 }}>{formatGroupTime(item.lastTime)}</Text>}
                </View>
                <View style={{ flexDirection:'row', alignItems:'center', marginTop:2 }}>
                  <Text style={{ fontSize:12, color: item.removed ? WARN : palette.textMuted, flex:1 }} numberOfLines={1}>{sub}</Text>
                  {item.unread > 0 && (
                    <View style={[gs.badge, { backgroundColor:accent, marginLeft:8 }]}>
                      <Text style={{ fontSize:11, fontWeight:'600', color:'white' }}>{item.unread > 99 ? '99+' : item.unread}</Text>
                    </View>
                  )}
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

// ─── Neue Gruppe ────────────────────────────────────────────────────────────
// Nur Kontakte mit bekannter Mitglieds-ID (kommt bei jeder Verbindung ueber
// den 1:1-Kanal) - ohne sie koennten die anderen Mitglieder diese Person
// nicht zuordnen.
// Knopf "Neuen Kontakt koppeln" (Nutzerwunsch 2026-10-19): fuehrt zur
// Kopplung; danach kommt der neue Kontakt automatisch in die Gruppe bzw. ist
// beim Erstellen schon ausgewaehlt (App.tsx, pendingGroupAdd).
function PairNewRow({ onPress, palette, accent }) {
  return (
    <TouchableOpacity onPress={onPress} accessibilityLabel={t('groupsUi.neuenKontaktKoppeln')}
      style={{ flexDirection:'row', alignItems:'center', paddingVertical:10 }}>
      <View style={{ width:36, height:36, borderRadius:18, alignItems:'center', justifyContent:'center',
        backgroundColor: palette.avatarBg || palette.surfaceAlt }}>
        <Icon name="plus" size={18} color={palette.avatarText || accent} />
      </View>
      <View style={{ flex:1, marginLeft:10 }}>
        <Text style={{ fontSize:15, color:palette.accentFg || accent, fontWeight:'500' }}>{t('groupsUi.neuenKontaktKoppeln')}</Text>
        <Text style={{ fontSize:11, color:palette.textMuted }}>{t('groupsUi.koppelnUndDirektInDie')}</Text>
      </View>
    </TouchableOpacity>
  );
}

export function GroupCreateScreen({ contacts, onBack, onCreate, onPairNew = null, initialSelected = null, palette = DEFAULT_PALETTE, accent = DEFAULT_PALETTE.green }) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [selected, setSelected] = React.useState(() => new Set(Array.isArray(initialSelected) ? initialSelected : []));
  // Frisch gekoppelter Kontakt (ueber "Neuen Kontakt koppeln") vorauswaehlen.
  React.useEffect(() => {
    if (!Array.isArray(initialSelected) || !initialSelected.length) return;
    setSelected(s => { const next = new Set(s); for (const id of initialSelected) next.add(id); return next; });
  }, [initialSelected && initialSelected.join(',')]);
  const [busy, setBusy] = React.useState(false);
  const maxOthers = GROUP_MAX_MEMBERS - 1;
  const usable = (contacts || []).filter(c => !c.pendingDelete && !c.wiped);

  const toggleMember = (id) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else if (next.size < maxOthers) next.add(id);
      return next;
    });
  };

  const canCreate = name.trim().length > 0 && selected.size > 0 && !busy;
  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    const res = await onCreate({ name: name.trim(), description: description.trim(), memberContactIds: Array.from(selected) });
    setBusy(false);
    if (res?.error === 'missing_member_id') {
      Alert.alert(t('common.notReady'), t('groups.missingIds', { names: res.missing.join(', ') }));
    } else if (res?.error) {
      Alert.alert(t('common.group'), t('groups.createFailed'));
    }
  };

  return (
    <View style={{ flex:1, backgroundColor:palette.bg }}>
      <Header title={t('groups.new')} onBack={onBack} palette={palette}
        right={(
          <TouchableOpacity disabled={!canCreate} onPress={submit} style={{ padding:4 }}>
            <Icon name="check" size={22} color={canCreate ? accent : palette.textMuted} />
          </TouchableOpacity>
        )} />
      <ScrollView contentContainerStyle={{ padding:16, gap:12 }}>
        <TextInput value={name} onChangeText={setName} placeholder={t('groups.namePlaceholder')}
          placeholderTextColor={palette.textMuted} maxLength={80}
          style={{ backgroundColor:palette.surface, borderRadius:10, borderWidth:0.5, borderColor:palette.border,
            paddingHorizontal:14, paddingVertical:10, fontSize:15, color:palette.text }} />
        <TextInput value={description} onChangeText={setDescription} placeholder={t('groups.descPlaceholder')}
          placeholderTextColor={palette.textMuted} multiline maxLength={500}
          style={{ backgroundColor:palette.surface, borderRadius:10, borderWidth:0.5, borderColor:palette.border,
            paddingHorizontal:14, paddingVertical:10, fontSize:15, color:palette.text, minHeight:60 }} />
        <Text style={{ fontSize:12, color:palette.textMuted, lineHeight:17 }}>
          {t('groups.createInfo')}
        </Text>
        <Text style={{ fontSize:13, fontWeight:'500', color:palette.textMuted, marginTop:8 }}>
          {t('groups.selectMembers', { n: selected.size + 1, max: GROUP_MAX_MEMBERS })}
        </Text>
        {usable.length === 0 ? (
          <Text style={{ fontSize:13, color:palette.textMuted }}>
            {t('groups.noContacts')}
          </Text>
        ) : usable.map(c => {
          const isSelected = selected.has(c.id);
          const ready = !!memberIdOfContact(c);
          const disabled = !ready || (!isSelected && selected.size >= maxOthers);
          return (
            <TouchableOpacity key={c.id} onPress={() => toggleMember(c.id)} disabled={disabled}
              style={{ flexDirection:'row', alignItems:'center', paddingVertical:8, opacity: disabled ? 0.45 : 1 }}>
              <MemberAvatar contact={c} name={c.name} size={36} palette={palette} />
              <View style={{ flex:1, marginLeft:10 }}>
                <Text style={{ fontSize:15, color:palette.text }}>{c.name}</Text>
                {!ready && (
                  <Text style={{ fontSize:11, color:palette.textMuted }}>{t('groups.noGroupId')}</Text>
                )}
              </View>
              <Icon name={isSelected ? 'check-square' : 'square'} size={20} color={isSelected ? accent : palette.textMuted} />
            </TouchableOpacity>
          );
        })}
        {!!onPairNew && selected.size < maxOthers && <PairNewRow onPress={onPairNew} palette={palette} accent={accent} />}
      </ScrollView>
    </View>
  );
}

// ─── Gruppeninfo ────────────────────────────────────────────────────────────
export function GroupDetailScreen({ group, contacts, onBack, onLeft, pickImage, onPairNew = null, palette = DEFAULT_PALETTE, accent = DEFAULT_PALETTE.green }) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(group?.name || '');
  const [description, setDescription] = React.useState(group?.description || '');
  const [addOpen, setAddOpen] = React.useState(false);

  React.useEffect(() => { setName(group?.name || ''); setDescription(group?.description || ''); }, [group?.groupId, group?.rev]);

  if (!group) return null;
  const members = resolveGroupMembers(group, contacts);
  const unreachable = unreachableMembers(group, contacts);
  const isAdmin = !!group.amAdmin && !group.removed;
  const memberMids = new Set((group.members || []).map(m => m.mid));
  const addable = (contacts || []).filter(c => !c.pendingDelete && !c.wiped && !memberMids.has(memberIdOfContact(c)));
  const free = GROUP_MAX_MEMBERS - members.length;

  const removeMember = (m) => {
    Alert.alert(t('groups.removeMember.title'), t('groups.removeMember.body', { name: m.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.remove'), style: 'destructive', onPress: () => {
        removeGroupMember(group.groupId, m.mid).then((r) => {
          if (r?.error) Alert.alert(t('common.group'), t('groups.removeFailed'));
        }).catch(() => {});
      } },
    ]);
  };

  const addMember = (c) => {
    setAddOpen(false);
    addGroupMembers(group.groupId, [c.id]).then((r) => {
      if (r?.error === 'missing_member_id') Alert.alert(t('common.notReady'), t('groups.missingId', { name: c.name }));
      else if (r?.error) Alert.alert(t('common.group'), t('groups.addFailed'));
    }).catch(() => {});
  };

  const leave = () => {
    Alert.alert(t('groups.leave.title'),
      t('groups.leave.body')
      + (group.amAdmin ? ' ' + t('groups.leave.adminHint') : ''), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('groups.leave.confirm'), style: 'destructive', onPress: () => { leaveGroup(group.groupId).catch(() => {}).then(() => onLeft?.()); } },
    ]);
  };

  const deleteLocal = () => {
    Alert.alert(t('groups.delete.title'), t('groups.delete.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: () => { deleteGroupLocally(group.groupId).catch(() => {}).then(() => onLeft?.()); } },
    ]);
  };

  const pickAvatar = () => {
    if (typeof pickImage !== 'function') return;
    pickImage({ mediaType:'photo', quality:0.8, includeBase64:true, maxWidth:512, maxHeight:512 }, (res) => {
      const asset = res?.assets?.[0];
      if (asset?.base64) setGroupAvatarLocal(group.groupId, `data:${asset.type || 'image/jpeg'};base64,${asset.base64}`).catch(() => {});
    });
  };

  return (
    <View style={{ flex:1, backgroundColor:palette.bg }}>
      <Header title={group.name} onBack={onBack} palette={palette}
        right={isAdmin ? (
          <TouchableOpacity onPress={() => {
            if (editing) {
              updateGroupInfo(group.groupId, { name: name.trim() || group.name, description: description.trim() }).catch(() => {});
            }
            setEditing(e => !e);
          }} style={{ padding:4 }}>
            <Icon name={editing ? 'check' : 'edit-2'} size={20} color={accent} />
          </TouchableOpacity>
        ) : null} />
      <ScrollView contentContainerStyle={{ padding:16, gap:16 }}>
        <View style={{ alignItems:'center', gap:8 }}>
          <TouchableOpacity onPress={pickAvatar}>
            <GroupAvatar group={group} size={72} accent={accent} palette={palette} />
          </TouchableOpacity>
          <Text style={{ fontSize:11, color:palette.textMuted }}>{t('groups.avatarHint')}</Text>
          {editing ? (
            <>
              <TextInput value={name} onChangeText={setName} placeholder={t('groups.namePlaceholder')} maxLength={80}
                placeholderTextColor={palette.textMuted}
                style={{ fontSize:17, color:palette.text, textAlign:'center', minWidth:200 }} />
              <TextInput value={description} onChangeText={setDescription} placeholder={t('groups.descPlaceholder')}
                placeholderTextColor={palette.textMuted} multiline maxLength={500}
                style={{ fontSize:13, color:palette.textMuted, textAlign:'center', minWidth:200 }} />
            </>
          ) : (
            !!group.description && <Text style={{ fontSize:13, color:palette.textMuted, textAlign:'center' }}>{group.description}</Text>
          )}
        </View>

        {group.removed && (
          <View style={{ backgroundColor:palette.surface, borderRadius:10, padding:12, borderWidth:0.5, borderColor:WARN }}>
            <Text style={{ fontSize:13, color:WARN }}>{t('groups.removedInfo')}</Text>
          </View>
        )}

        {unreachable.length > 0 && !group.removed && (
          <View style={{ backgroundColor:palette.surface, borderRadius:10, padding:12, borderWidth:0.5, borderColor:palette.border }}>
            <Text style={{ fontSize:13, color:palette.text, lineHeight:19 }}>
              {t('groups.notConnected', { names: unreachable.map(m => m.name).join(', ') })}
            </Text>
            <Text style={{ fontSize:12, color:palette.textMuted, marginTop:4, lineHeight:17 }}>
              {t('groups.noRelay')}
            </Text>
          </View>
        )}

        <View>
          <View style={{ flexDirection:'row', alignItems:'center', marginBottom:8 }}>
            <Text style={{ fontSize:13, fontWeight:'500', color:palette.textMuted, flex:1 }}>
              {t('groups.members', { n: members.length, max: GROUP_MAX_MEMBERS })}
            </Text>
            {isAdmin && free > 0 && (
              <TouchableOpacity onPress={() => setAddOpen(true)} style={{ flexDirection:'row', alignItems:'center', gap:4, padding:4 }}>
                <Icon name="user-plus" size={16} color={accent} />
                <Text style={{ fontSize:13, color:accent }}>{t('groups.add')}</Text>
              </TouchableOpacity>
            )}
          </View>
          {members.map(m => {
            const c = m.contactId ? (contacts || []).find(x => x.id === m.contactId) : null;
            return (
              <View key={m.mid} style={{ flexDirection:'row', alignItems:'center', paddingVertical:6 }}>
                {m.isSelf ? (
                  <View style={{ width:36, height:36, borderRadius:18, backgroundColor:palette.surfaceAlt,
                    alignItems:'center', justifyContent:'center' }}>
                    <Text style={{ fontSize:13, fontWeight:'500', color:accent }}>{t('common.you')}</Text>
                  </View>
                ) : (
                  <MemberAvatar contact={c} name={m.name} size={36} palette={palette} />
                )}
                <View style={{ flex:1, marginLeft:10 }}>
                  <Text style={{ fontSize:15, color:palette.text }}>{m.name}{m.isAdmin ? ' · ' + t('groups.admin') : ''}</Text>
                  {!m.isSelf && !m.contactId && (
                    <Text style={{ fontSize:11, color:WARN }}>{t('groups.memberNotConnected')}</Text>
                  )}
                </View>
                {isAdmin && !m.isSelf && (
                  <TouchableOpacity onPress={() => removeMember(m)} style={{ padding:6 }}>
                    <Icon name="user-minus" size={18} color={DANGER} />
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>

        <Text style={{ fontSize:11, color:palette.textMuted, lineHeight:16 }}>
          {t('groups.adminInfo')}
        </Text>

        {group.removed ? (
          <TouchableOpacity onPress={deleteLocal}
            style={{ paddingVertical:12, alignItems:'center', borderRadius:10,
              backgroundColor:palette.surface, borderWidth:0.5, borderColor:DANGER, marginTop:12 }}>
            <Text style={{ color:DANGER, fontSize:14, fontWeight:'500' }}>{t('groups.deleteLocal')}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={leave}
            style={{ paddingVertical:12, alignItems:'center', borderRadius:10,
              backgroundColor:palette.surface, borderWidth:0.5, borderColor:DANGER, marginTop:12 }}>
            <Text style={{ color:DANGER, fontSize:14, fontWeight:'500' }}>{t('groups.leave.title')}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      <Modal visible={addOpen} transparent animationType="slide" onRequestClose={() => setAddOpen(false)}>
        <View style={{ flex:1, backgroundColor:'rgba(0,0,0,0.5)', justifyContent:'flex-end' }}>
          <View style={{ backgroundColor:palette.surface, borderTopLeftRadius:24, borderTopRightRadius:24, padding:20, paddingBottom:36, maxHeight:'70%' }}>
            <Text style={{ fontSize:17, fontWeight:'600', color:palette.text, marginBottom:12 }}>{t('groups.addMember')}</Text>
            <ScrollView>
              {addable.length === 0 ? (
                <Text style={{ fontSize:13, color:palette.textMuted }}>{t('groups.noMoreContacts')}</Text>
              ) : null}
              {addable.map(c => {
                const ready = !!memberIdOfContact(c);
                return (
                  <TouchableOpacity key={c.id} disabled={!ready} onPress={() => addMember(c)}
                    style={{ flexDirection:'row', alignItems:'center', paddingVertical:8, opacity: ready ? 1 : 0.45 }}>
                    <MemberAvatar contact={c} name={c.name} size={36} palette={palette} />
                    <View style={{ flex:1, marginLeft:10 }}>
                      <Text style={{ fontSize:15, color:palette.text }}>{c.name}</Text>
                      {!ready && <Text style={{ fontSize:11, color:palette.textMuted }}>{t('groups.noGroupId')}</Text>}
                    </View>
                    <Icon name="plus" size={18} color={ready ? accent : palette.textMuted} />
                  </TouchableOpacity>
                );
              })}
              {!!onPairNew && free > 0 && (
                <PairNewRow onPress={() => { setAddOpen(false); onPairNew(); }} palette={palette} accent={accent} />
              )}
            </ScrollView>
            <TouchableOpacity onPress={() => setAddOpen(false)} style={{ marginTop:12, padding:12, alignItems:'center' }}>
              <Text style={{ color:palette.textMuted, fontSize:15 }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}
