/**
 * Tab navigation — Home, Explore, My eSIMs, Numbers, Activity, Profile.
 */

import { Tabs } from "expo-router";
import { Home, Compass, Smartphone, Phone, Activity, User } from "lucide-react-native";
import { useAuth } from "../../lib/auth";
import { Redirect } from "expo-router";

export default function TabLayout() {
  const { user, loading } = useAuth();

  if (loading) return null;
  if (!user) return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#0d9488",
        headerShown: false,
        tabBarStyle: { paddingBottom: 4 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: ({ color }) => <Home size={22} color={color} /> }} />
      <Tabs.Screen name="explore" options={{ title: "Explore", tabBarIcon: ({ color }) => <Compass size={22} color={color} /> }} />
      <Tabs.Screen name="esims" options={{ title: "My eSIMs", tabBarIcon: ({ color }) => <Smartphone size={22} color={color} /> }} />
      <Tabs.Screen name="numbers" options={{ title: "Numbers", tabBarIcon: ({ color }) => <Phone size={22} color={color} /> }} />
      <Tabs.Screen name="activity" options={{ title: "Activity", tabBarIcon: ({ color }) => <Activity size={22} color={color} /> }} />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: ({ color }) => <User size={22} color={color} /> }} />
    </Tabs>
  );
}
