use std::{collections::BTreeMap, io, ptr};

use windows_sys::{
    Win32::{
        Foundation::{FWP_E_ALREADY_EXISTS, HANDLE},
        NetworkManagement::{
            WindowsFilteringPlatform::*,
            WindowsFirewall::{
                NetworkIsolationGetAppContainerConfig, NetworkIsolationSetAppContainerConfig,
            },
        },
        Security::{EqualSid, SID_AND_ATTRIBUTES},
        System::Memory::{GetProcessHeap, HeapFree},
    },
    core::GUID,
};

use super::security::{check, derive_sid, wide};
use crate::windows_security::Sid;

const PROVIDER: GUID = GUID::from_u128(0x56b83290_4c62_4a13_9920_248a5301ec0d);
const SUBLAYER: GUID = GUID::from_u128(0xbd1ce7af_258b_49a1_871e_f20169b605ce);
const LAYERS: [GUID; 6] = [
    FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
    FWPM_LAYER_ALE_AUTH_LISTEN_V4,
    FWPM_LAYER_ALE_AUTH_LISTEN_V6,
];

pub(super) struct Network(HANDLE);

impl Network {
    pub(super) fn verify(&self) -> io::Result<()> {
        let mut provider = ptr::null_mut();
        let mut layer = ptr::null_mut();
        // SAFETY: The engine is live and both keys are fixed product identifiers.
        check(unsafe { FwpmProviderGetByKey0(self.0, &PROVIDER, &mut provider) })?;
        let _provider = FilterMemory(provider.cast());
        // SAFETY: BFE allocates the matching complete structures on successful queries.
        check(unsafe { FwpmSubLayerGetByKey0(self.0, &SUBLAYER, &mut layer) })?;
        let _layer = FilterMemory(layer.cast());
        // SAFETY: Both API-owned allocations remain live until after inspection.
        if unsafe {
            (*provider).flags & FWPM_PROVIDER_FLAG_PERSISTENT == 0
                || (*layer).flags & FWPM_SUBLAYER_FLAG_PERSISTENT == 0
                || (*layer).providerKey.is_null()
                || (*(*layer).providerKey).data1 != PROVIDER.data1
                || (*(*layer).providerKey).data2 != PROVIDER.data2
                || (*(*layer).providerKey).data3 != PROVIDER.data3
                || (*(*layer).providerKey).data4 != PROVIDER.data4
        } {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(())
    }

    pub(super) fn open() -> io::Result<Self> {
        let mut handle = ptr::null_mut();
        // SAFETY: Null server/identity select the local authenticated BFE session; output is writable.
        check(unsafe { FwpmEngineOpen0(ptr::null(), 10, ptr::null(), ptr::null(), &mut handle) })?;
        Ok(Self(handle))
    }

    pub(super) fn install(&self) -> io::Result<()> {
        let mut provider_key = PROVIDER;
        let mut name = wide("Lexora Buddy Sandbox");
        let provider = FWPM_PROVIDER0 {
            providerKey: PROVIDER,
            flags: FWPM_PROVIDER_FLAG_PERSISTENT,
            displayData: FWPM_DISPLAY_DATA0 {
                name: name.as_mut_ptr(),
                description: ptr::null_mut(),
            },
            ..Default::default()
        };
        // SAFETY: The provider's input strings are live for the synchronous API call.
        existing(unsafe { FwpmProviderAdd0(self.0, &provider, ptr::null_mut()) })?;
        let layer = FWPM_SUBLAYER0 {
            subLayerKey: SUBLAYER,
            providerKey: &mut provider_key,
            flags: FWPM_SUBLAYER_FLAG_PERSISTENT,
            weight: 0x7fff,
            displayData: FWPM_DISPLAY_DATA0 {
                name: name.as_mut_ptr(),
                description: ptr::null_mut(),
            },
            ..Default::default()
        };
        // SAFETY: The provider already exists and all sublayer inputs remain live.
        existing(unsafe { FwpmSubLayerAdd0(self.0, &layer, ptr::null_mut()) })
    }

    pub(super) fn grant(&self, profile: &str) -> io::Result<Vec<u64>> {
        let sid = derive_sid(profile)?;
        // SAFETY: The engine is live; the transaction is closed on every path below.
        check(unsafe { FwpmTransactionBegin0(self.0, 0) })?;
        let result: io::Result<Vec<u64>> = (|| {
            let mut filters = Vec::new();
            for index in 0..LAYERS.len() {
                filters.push(self.filter(index, profile, &sid, false)?);
                filters.push(self.filter(index, profile, &sid, true)?);
            }
            // SAFETY: All filters were added to this engine's active transaction.
            check(unsafe { FwpmTransactionCommit0(self.0) })?;
            Ok(filters)
        })();
        if result.is_err() {
            // SAFETY: Abort safely discards any uncommitted rules; an already closed transaction is harmless.
            unsafe { FwpmTransactionAbort0(self.0) };
        }
        let filters = result?;
        if let Err(error) = loopback(&sid, true) {
            self.revoke(profile, &filters)?;
            return Err(error);
        }
        Ok(filters)
    }

    fn filter(
        &self,
        index: usize,
        profile: &str,
        sid: &Sid,
        allow_loopback: bool,
    ) -> io::Result<u64> {
        let layer = LAYERS[index];
        let mut conditions = vec![condition(
            FWPM_CONDITION_ALE_PACKAGE_ID,
            FWP_SID,
            FWP_CONDITION_VALUE0_0 {
                sid: sid.as_ptr().cast(),
            },
        )];
        let mut v4 = FWP_V4_ADDR_AND_MASK {
            addr: 0x7f000000,
            mask: 0xff000000,
        };
        let mut v6 = FWP_V6_ADDR_AND_MASK {
            addr: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            prefixLength: 128,
        };
        if allow_loopback {
            let listening = index >= 4;
            let ipv6 = index % 2 == 1;
            let address = if listening {
                FWPM_CONDITION_IP_LOCAL_ADDRESS
            } else {
                FWPM_CONDITION_IP_REMOTE_ADDRESS
            };
            conditions.push(if ipv6 {
                condition(
                    address,
                    FWP_V6_ADDR_MASK,
                    FWP_CONDITION_VALUE0_0 {
                        v6AddrMask: &mut v6,
                    },
                )
            } else {
                condition(
                    address,
                    FWP_V4_ADDR_MASK,
                    FWP_CONDITION_VALUE0_0 {
                        v4AddrMask: &mut v4,
                    },
                )
            });
            if !listening {
                conditions.push(condition(
                    FWPM_CONDITION_IP_PROTOCOL,
                    FWP_UINT8,
                    FWP_CONDITION_VALUE0_0 { uint8: 6 },
                ));
            }
        }
        let mut provider = PROVIDER;
        let mut name = wide("Lexora Buddy command boundary");
        let mut weight = if allow_loopback { 100u64 } else { 1 };
        let filter = FWPM_FILTER0 {
            flags: FWPM_FILTER_FLAG_PERSISTENT,
            providerKey: &mut provider,
            providerData: FWP_BYTE_BLOB {
                size: profile.len() as u32,
                data: profile.as_ptr().cast_mut(),
            },
            displayData: FWPM_DISPLAY_DATA0 {
                name: name.as_mut_ptr(),
                description: ptr::null_mut(),
            },
            layerKey: layer,
            subLayerKey: SUBLAYER,
            weight: FWP_VALUE0 {
                r#type: FWP_UINT64,
                Anonymous: FWP_VALUE0_0 {
                    uint64: &mut weight,
                },
            },
            numFilterConditions: conditions.len() as u32,
            filterCondition: conditions.as_mut_ptr(),
            action: FWPM_ACTION0 {
                r#type: if allow_loopback {
                    FWP_ACTION_PERMIT
                } else {
                    FWP_ACTION_BLOCK
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let mut id = 0;
        // SAFETY: All pointer-backed filter fields refer to live input storage until the API has copied them.
        check(unsafe { FwpmFilterAdd0(self.0, &filter, ptr::null_mut(), &mut id) })?;
        Ok(id)
    }

    pub(super) fn revoke(&self, profile: &str, filters: &[u64]) -> io::Result<()> {
        loopback(&derive_sid(profile)?, false)?;
        for id in filters {
            // SAFETY: These IDs were returned for this product's own per-command filters.
            check(unsafe { FwpmFilterDeleteById0(self.0, *id) })?;
        }
        Ok(())
    }

    pub(super) fn recover(&self) -> io::Result<()> {
        let mut profiles: BTreeMap<String, Vec<u64>> = BTreeMap::new();
        for layer in LAYERS {
            let mut provider = PROVIDER;
            let template = FWPM_FILTER_ENUM_TEMPLATE0 {
                providerKey: &mut provider,
                layerKey: layer,
                enumType: FWP_FILTER_ENUM_FULLY_CONTAINED,
                actionMask: u32::MAX,
                ..Default::default()
            };
            let mut enumeration = ptr::null_mut();
            // SAFETY: The enumeration is scoped to this product's provider and one known layer.
            check(unsafe { FwpmFilterCreateEnumHandle0(self.0, &template, &mut enumeration) })?;
            let result: io::Result<()> = (|| {
                loop {
                    let mut entries = ptr::null_mut();
                    let mut count = 0;
                    // SAFETY: The enumeration belongs to the live engine; returned entries are BFE-owned allocations.
                    check(unsafe {
                        FwpmFilterEnum0(self.0, enumeration, 256, &mut entries, &mut count)
                    })?;
                    let memory = FilterMemory(entries.cast());
                    if count == 0 {
                        break;
                    }
                    if count > 256 || entries.is_null() {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    // SAFETY: BFE returned count initialized filter pointers with live backing allocations.
                    for entry in unsafe { std::slice::from_raw_parts(entries, count as usize) } {
                        // SAFETY: Each returned pointer denotes one complete filter in the enumeration allocation.
                        let entry = unsafe { &**entry };
                        if entry.providerData.size > 128 || entry.providerData.data.is_null() {
                            return Err(io::ErrorKind::InvalidData.into());
                        }
                        // SAFETY: providerData length is bounded above and the filter allocation is live.
                        let data = unsafe {
                            std::slice::from_raw_parts(
                                entry.providerData.data,
                                entry.providerData.size as usize,
                            )
                        };
                        let profile =
                            std::str::from_utf8(data).map_err(|_| io::ErrorKind::InvalidData)?;
                        if !valid_profile(profile) {
                            return Err(io::ErrorKind::InvalidData.into());
                        }
                        profiles
                            .entry(profile.to_owned())
                            .or_default()
                            .push(entry.filterId);
                    }
                    drop(memory);
                }
                Ok(())
            })();
            // SAFETY: This is the matching release for this live enumeration.
            unsafe { FwpmFilterDestroyEnumHandle0(self.0, enumeration) };
            result?;
        }
        for (profile, filters) in profiles {
            self.revoke(&profile, &filters)?;
        }
        Ok(())
    }

    pub(super) fn uninstall(&self) -> io::Result<()> {
        self.recover()?;
        // SAFETY: Recovery removed this product's filters; these GUIDs belong exclusively to this product.
        check(unsafe { FwpmSubLayerDeleteByKey0(self.0, &SUBLAYER) })?;
        // SAFETY: The product sublayer has been removed before deleting its provider.
        check(unsafe { FwpmProviderDeleteByKey0(self.0, &PROVIDER) })
    }
}

impl Drop for Network {
    fn drop(&mut self) {
        // SAFETY: This closes the owned BFE handle. Persistent fences deliberately survive broker crashes.
        unsafe { FwpmEngineClose0(self.0) };
    }
}

fn condition(field: GUID, kind: i32, value: FWP_CONDITION_VALUE0_0) -> FWPM_FILTER_CONDITION0 {
    FWPM_FILTER_CONDITION0 {
        fieldKey: field,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0 {
            r#type: kind,
            Anonymous: value,
        },
    }
}

pub(super) fn valid_profile(name: &str) -> bool {
    name.strip_prefix(super::PROFILE_PREFIX)
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn existing(code: u32) -> io::Result<()> {
    if code == FWP_E_ALREADY_EXISTS as u32 {
        Ok(())
    } else {
        check(code)
    }
}

struct FilterMemory(*mut std::ffi::c_void);
impl Drop for FilterMemory {
    fn drop(&mut self) {
        // SAFETY: The allocation came from a matching Fwpm enumeration API.
        unsafe { FwpmFreeMemory0(&mut self.0) };
    }
}

fn loopback(sid: &Sid, enabled: bool) -> io::Result<()> {
    let mut count = 0;
    let mut original = ptr::null_mut();
    // SAFETY: Both outputs are writable; the API allocates the complete existing configuration.
    check(unsafe { NetworkIsolationGetAppContainerConfig(&mut count, &mut original) })?;
    if count > 65536 || (count > 0 && original.is_null()) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let _memory = LoopbackMemory {
        entries: original,
        count,
    };
    let mut entries = if count == 0 {
        Vec::new()
    } else {
        // SAFETY: The API returned count initialized entries in live allocation storage.
        unsafe { std::slice::from_raw_parts(original, count as usize) }.to_vec()
    };
    // SAFETY: Every entry SID is backed by the original live allocation; sid is independently owned.
    entries.retain(|entry| unsafe { EqualSid(entry.Sid, sid.as_ptr()) } == 0);
    if enabled {
        entries.push(SID_AND_ATTRIBUTES {
            Sid: sid.as_ptr(),
            Attributes: 0,
        });
    }
    // SAFETY: Preserve unrelated exemptions; only this fresh command identity is added or removed.
    check(unsafe { NetworkIsolationSetAppContainerConfig(entries.len() as u32, entries.as_ptr()) })
}

struct LoopbackMemory {
    entries: *mut SID_AND_ATTRIBUTES,
    count: u32,
}
impl Drop for LoopbackMemory {
    fn drop(&mut self) {
        // SAFETY: NetworkIsolationGetAppContainerConfig allocates each SID and its array from the process heap.
        unsafe {
            let heap = GetProcessHeap();
            for index in 0..self.count {
                HeapFree(heap, 0, (*self.entries.add(index as usize)).Sid);
            }
            if !self.entries.is_null() {
                HeapFree(heap, 0, self.entries.cast());
            }
        }
    }
}
