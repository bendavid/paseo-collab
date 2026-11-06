import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginButtonContentProps, useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { createLinkRpc, type Link, listLinksRpc, stopLinkRpc } from "../shared/links";
import { openExternal } from "./web";

const LIST_REFRESH_MS = 4_000;

function guestLabel(link: Link): string {
  if (link.participants.length === 0) return "No guests connected";
  return link.participants.length === 1
    ? "1 guest connected"
    : `${link.participants.length} guests connected`;
}

export function SharePopover(props: PluginButtonContentProps) {
  const { theme } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const listLinks = useRpc(listLinksRpc);
  const createLink = useRpc(createLinkRpc);
  const stopLink = useRpc(stopLinkRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [allowPrompts, setAllowPrompts] = useState(false);

  const queryKey = ["links", agentId];
  const links = useQuery({
    queryKey,
    queryFn: () => listLinks({ agentId: agentId ?? undefined }),
    enabled: agentId !== null,
    refetchInterval: LIST_REFRESH_MS,
  });
  const create = useMutation({
    mutationFn: () => createLink({ agentId: agentId ?? "", allowPrompts }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const stop = useMutation({
    mutationFn: (linkId: string) => stopLink({ linkId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const styles = useMemo(
    () => ({
      body: { gap: 12, maxWidth: 420 },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      participants: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      participant: {
        color: theme.colors.foreground,
        fontSize: 12,
        paddingVertical: 2,
        paddingHorizontal: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      url: {
        color: theme.colors.foreground,
        fontSize: 12,
        padding: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      row: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      toggle: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
      },
      primary: {
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 6,
        backgroundColor: theme.colors.accent,
      },
      primaryText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      secondary: {
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      secondaryText: { color: theme.colors.foreground },
    }),
    [theme],
  );

  if (!agentId) return <Text style={styles.muted}>Open this from an agent's composer.</Text>;
  if (links.isPending) return <Text style={styles.muted}>Loading…</Text>;
  if (links.error) return <Text style={styles.danger}>{links.error.message}</Text>;

  const link = links.data.links[0];

  async function copyLink(url: string) {
    try {
      await copyText(url);
      toast.show("Link copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the link and copy it.");
    }
  }

  if (link) {
    return (
      <View style={styles.body}>
        <Text style={styles.title}>Shared with a link</Text>
        <Text style={styles.url} selectable numberOfLines={3}>
          {link.url}
        </Text>
        <Text style={styles.muted}>
          {guestLabel(link)} · {link.allowPrompts ? "Guests can send prompts" : "View only"}
        </Text>
        {link.participants.length > 0 ? (
          <View style={styles.participants} accessibilityLabel="Connected guests">
            {link.participants.map((name) => (
              <Text key={name} style={styles.participant}>
                {name}
              </Text>
            ))}
          </View>
        ) : null}
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            style={styles.primary}
            onPress={() => void copyLink(link.url)}
          >
            <Text style={styles.primaryText}>Copy link</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.secondary}
            onPress={() => void openExternal(link.url)}
          >
            <Text style={styles.secondaryText}>Open</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.secondary}
            disabled={stop.isPending}
            onPress={() => stop.mutate(link.linkId)}
          >
            <Text style={styles.secondaryText}>{stop.isPending ? "Stopping…" : "Stop link"}</Text>
          </Pressable>
        </View>
        {stop.error ? <Text style={styles.danger}>{stop.error.message}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <Text style={styles.title}>Collaborate on this agent</Text>
      <Text style={styles.muted}>
        Creates a one-off link to a web page guests open in any browser. The conversation travels
        through the Paseo relay, end-to-end encrypted between this daemon and the guest's browser;
        the key is in the link and never reaches the relay or the page's host. Anyone holding the
        link can join until you stop it.
      </Text>
      <View style={styles.toggle}>
        <Text style={styles.text}>Let guests send prompts</Text>
        <Switch value={allowPrompts} onValueChange={setAllowPrompts} />
      </View>
      <Text style={styles.muted}>
        Guests see everything in the conversation, including tool calls with their full inputs and
        outputs: commands and their output, file contents, changes, fetched web pages, and MCP tool
        data. Nothing is filtered or redacted, so share only with people who may see all of it.
      </Text>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          style={styles.primary}
          disabled={create.isPending}
          onPress={() => create.mutate()}
        >
          <Text style={styles.primaryText}>
            {create.isPending ? "Registering with the relay…" : "Create link"}
          </Text>
        </Pressable>
      </View>
      {create.error ? <Text style={styles.danger}>{create.error.message}</Text> : null}
    </View>
  );
}
